import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  AGENT_PROFILES,
  DEFAULT_AGENT_TRUST_TIER_BY_PROFILE,
  assertRunTransition,
  assertTaskTransition,
  isTerminalRunStatus,
  type RunExitReason,
  type RunEventLevel,
  type RunEventType,
  type RunStatus,
  type TaskStatus
} from "@salvo/shared";
import type {
  CreateAuditEventInput,
  DaemonType,
  CreateContractInput,
  DbTaskChatMessage,
  DbTaskChatSession,
  DbIdempotencyKey,
  CreateMemoryInput,
  CreateResearchInput,
  CreateRunInput,
  CreateTaskInput,
  DbContract,
  DbDaemonHeartbeat,
  DbEvaluation,
  DbResearchExperiment,
  DbResearchReviewStatus,
  DbArtifact,
  DbAuditEvent,
  DbAgentTrustTier,
  DbBudgetLimit,
  DbBudgetStatus,
  DbSkillSetting,
  DbSkillUsage,
  DbContractMemoryContext,
  DbContractMemoryPrompt,
  DbIntegrationConfig,
  DbIntegrationKey,
  DbRun,
  DbRunSummary,
  DbRunEvent,
  DbTask,
  DbWorkspace,
  IdempotentResult,
  TaskChatProposal,
  ResearchIngestionCandidate,
  RecordEvaluationInput
} from "./types";

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "blocked",
  "cancelled"
]);

const RETRYABLE_RUN_STATUSES = new Set<RunStatus>(["failed", "blocked", "cancelled"]);
const CANCELLABLE_RUN_STATUSES = new Set<RunStatus>([
  "created",
  "provisioning",
  "starting",
  "running",
  "evaluating"
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTaskChatProposal(payload: Record<string, unknown> | null): TaskChatProposal | null {
  if (!payload) {
    return null;
  }
  if (!isPlainRecord(payload)) {
    return null;
  }

  const title = payload.title;
  const request = payload.request;
  const risk = payload.risk;
  const contractJson = payload.contract_json;
  const requiresApproval = payload.requires_approval;
  if (
    typeof title !== "string" ||
    title.trim().length === 0 ||
    typeof request !== "string" ||
    request.trim().length === 0
  ) {
    return null;
  }
  if (risk !== "low" && risk !== "medium" && risk !== "high") {
    return null;
  }
  if (!isPlainRecord(contractJson)) {
    return null;
  }
  if (requiresApproval !== undefined && typeof requiresApproval !== "boolean") {
    return null;
  }

  return {
    title: title.trim(),
    request: request.trim(),
    risk,
    requires_approval: requiresApproval ?? risk === "high",
    contract_json: contractJson
  };
}

export class SalvoRepository {
  constructor(private readonly pool: Pool) {}

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private singleOrThrow<T extends QueryResultRow>(rows: T[], notFoundMessage: string): T {
    const row = rows[0];
    if (!row) {
      throw new Error(notFoundMessage);
    }
    return row;
  }

  private buildIdempotencyExpiry(ttlHours = 24): string {
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
    return expiresAt.toISOString();
  }

  private async beginIdempotentRequest<T extends Record<string, unknown>>(
    client: PoolClient,
    scope: string,
    idempotencyKey: string,
    requestFingerprint: string,
    ttlHours = 24
  ): Promise<
    | { kind: "execute" }
    | { kind: "replay"; responseStatus: number; responseJson: T }
  > {
    const expiresAt = this.buildIdempotencyExpiry(ttlHours);
    const inserted = await client.query<DbIdempotencyKey>(
      `insert into public.salvo_idempotency_keys (
         scope,
         idempotency_key,
         request_fingerprint,
         status,
         expires_at
       )
       values ($1, $2, $3, 'processing', $4)
       on conflict do nothing
       returning *`,
      [scope, idempotencyKey, requestFingerprint, expiresAt]
    );

    if (inserted.rows[0]) {
      return { kind: "execute" };
    }

    const existingResult = await client.query<DbIdempotencyKey>(
      `select *
       from public.salvo_idempotency_keys
       where scope = $1
         and idempotency_key = $2
       for update`,
      [scope, idempotencyKey]
    );
    const existing = this.singleOrThrow(
      existingResult.rows,
      `Idempotency key not found: ${scope}:${idempotencyKey}`
    );

    const expired = new Date(existing.expires_at).getTime() <= Date.now();
    if (expired) {
      await client.query(
        `update public.salvo_idempotency_keys
         set request_fingerprint = $3,
             status = 'processing',
             response_status = null,
             response_json = null,
             expires_at = $4
         where scope = $1
           and idempotency_key = $2`,
        [scope, idempotencyKey, requestFingerprint, expiresAt]
      );
      return { kind: "execute" };
    }

    if (existing.request_fingerprint !== requestFingerprint) {
      throw new Error("Idempotency key already used for a different request.");
    }

    if (existing.status !== "completed" || existing.response_status === null || !existing.response_json) {
      throw new Error("A matching request is already in progress.");
    }

    return {
      kind: "replay",
      responseStatus: existing.response_status,
      responseJson: existing.response_json as T
    };
  }

  private async completeIdempotentRequest(
    client: PoolClient,
    scope: string,
    idempotencyKey: string,
    responseStatus: number,
    responseJson: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `update public.salvo_idempotency_keys
       set status = 'completed',
           response_status = $3,
           response_json = $4::jsonb
       where scope = $1
         and idempotency_key = $2`,
      [scope, idempotencyKey, responseStatus, JSON.stringify(responseJson)]
    );
  }

  private async insertTask(client: PoolClient, input: CreateTaskInput): Promise<DbTask> {
    const workspaceId = input.workspaceId ?? (await this.ensureWorkspace()).id;

    const title = input.title.trim() || "Untitled task";
    const request = input.request.trim();
    const normalized = request.replace(/\s+/g, " ");

    const result = await client.query<DbTask>(
      `insert into public.salvo_tasks (
         workspace_id,
         title,
         original_request,
         normalized_request,
         status,
         requires_approval
       )
       values ($1, $2, $3, $4, 'queued', $5)
       returning *`,
      [workspaceId, title, request, normalized, input.requiresApproval ?? false]
    );

    return this.singleOrThrow(result.rows, "Failed to create task.");
  }

  async ensureWorkspace(name = "default", localPath = process.cwd()): Promise<DbWorkspace> {
    const existing = await this.pool.query<DbWorkspace>(
      `select * from public.salvo_workspaces where name = $1 limit 1`,
      [name]
    );

    if (existing.rows[0]) {
      return existing.rows[0];
    }

    const inserted = await this.pool.query<DbWorkspace>(
      `insert into public.salvo_workspaces (name, local_path)
       values ($1, $2)
       returning *`,
      [name, localPath]
    );

    return this.singleOrThrow(inserted.rows, "Failed to create workspace.");
  }

  async listWorkspaces(): Promise<DbWorkspace[]> {
    const result = await this.pool.query<DbWorkspace>(
      `select *
       from public.salvo_workspaces
       order by created_at asc`
    );

    return result.rows;
  }

  async getWorkspace(workspaceId: string): Promise<DbWorkspace | null> {
    const result = await this.pool.query<DbWorkspace>(
      `select *
       from public.salvo_workspaces
       where id = $1
       limit 1`,
      [workspaceId]
    );

    return result.rows[0] ?? null;
  }

  async listAgentTrustTiers(workspaceId?: string): Promise<DbAgentTrustTier[]> {
    const [workspaces, storedResult] = await Promise.all([
      workspaceId
        ? this.pool.query<DbWorkspace>(
            `select *
             from public.salvo_workspaces
             where id = $1
             limit 1`,
            [workspaceId]
          )
        : this.pool.query<DbWorkspace>(
            `select *
             from public.salvo_workspaces
             order by name asc`
          ),
      this.pool.query<DbAgentTrustTier>(
        `select
           tiers.workspace_id,
           workspaces.name as workspace_name,
           tiers.agent_profile,
           tiers.trust_tier,
           tiers.successful_runs,
           tiers.last_run_at,
           tiers.promoted_at,
           tiers.managed_by,
           tiers.created_at,
           tiers.updated_at
         from public.salvo_agent_trust_tiers tiers
         join public.salvo_workspaces workspaces on workspaces.id = tiers.workspace_id
         where ($1::uuid is null or tiers.workspace_id = $1)
         order by workspaces.name asc, tiers.agent_profile asc`,
        [workspaceId ?? null]
      )
    ]);

    const storedByKey = new Map(
      storedResult.rows.map((row) => [`${row.workspace_id}:${row.agent_profile}`, row] as const)
    );

    return workspaces.rows.flatMap((workspace) =>
      AGENT_PROFILES.map((agentProfile) => {
        const stored = storedByKey.get(`${workspace.id}:${agentProfile}`);
        return (
          stored ?? {
            workspace_id: workspace.id,
            workspace_name: workspace.name,
            agent_profile: agentProfile,
            trust_tier: DEFAULT_AGENT_TRUST_TIER_BY_PROFILE[agentProfile],
            successful_runs: 0,
            last_run_at: null,
            promoted_at: null,
            managed_by: "system",
            created_at: null,
            updated_at: null
          }
        );
      })
    );
  }

  async getAgentTrustTier(workspaceId: string, agentProfile: DbAgentTrustTier["agent_profile"]): Promise<DbAgentTrustTier> {
    const tiers = await this.listAgentTrustTiers(workspaceId);
    const tier = tiers.find((entry) => entry.agent_profile === agentProfile);
    if (!tier) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    return tier;
  }

  async upsertAgentTrustTier(input: {
    workspaceId: string;
    agentProfile: DbAgentTrustTier["agent_profile"];
    trustTier: DbAgentTrustTier["trust_tier"];
    successfulRuns?: number;
    lastRunAt?: string | null;
    promotedAt?: string | null;
    managedBy?: DbAgentTrustTier["managed_by"];
  }): Promise<DbAgentTrustTier> {
    await this.pool.query(
      `insert into public.salvo_agent_trust_tiers (
         workspace_id,
         agent_profile,
         trust_tier,
         successful_runs,
         last_run_at,
         promoted_at,
         managed_by
       )
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (workspace_id, agent_profile)
       do update
         set trust_tier = excluded.trust_tier,
             successful_runs = excluded.successful_runs,
             last_run_at = excluded.last_run_at,
             promoted_at = excluded.promoted_at,
             managed_by = excluded.managed_by`,
      [
        input.workspaceId,
        input.agentProfile,
        input.trustTier,
        input.successfulRuns ?? 0,
        input.lastRunAt ?? null,
        input.promotedAt ?? null,
        input.managedBy ?? "manual"
      ]
    );

    return this.getAgentTrustTier(input.workspaceId, input.agentProfile);
  }

  async recordAgentTrustTierOutcome(
    workspaceId: string,
    agentProfile: DbAgentTrustTier["agent_profile"],
    succeeded: boolean
  ): Promise<{ before: DbAgentTrustTier; after: DbAgentTrustTier; promoted: boolean }> {
    return this.withTransaction(async (client) => {
      const workspaceResult = await client.query<DbWorkspace>(
        `select *
         from public.salvo_workspaces
         where id = $1
         limit 1`,
        [workspaceId]
      );
      const workspace = this.singleOrThrow(workspaceResult.rows, `Workspace not found: ${workspaceId}`);

      await client.query(
        `insert into public.salvo_agent_trust_tiers (
           workspace_id,
           agent_profile,
           trust_tier,
           successful_runs,
           managed_by
         )
         values ($1, $2, $3, 0, 'system')
         on conflict (workspace_id, agent_profile)
         do nothing`,
        [workspaceId, agentProfile, DEFAULT_AGENT_TRUST_TIER_BY_PROFILE[agentProfile]]
      );

      const currentResult = await client.query<Omit<DbAgentTrustTier, "workspace_name">>(
        `select
           workspace_id,
           agent_profile,
           trust_tier,
           successful_runs,
           last_run_at,
           promoted_at,
           managed_by,
           created_at,
           updated_at
         from public.salvo_agent_trust_tiers
         where workspace_id = $1
           and agent_profile = $2
         for update`,
        [workspaceId, agentProfile]
      );
      const current = this.singleOrThrow(currentResult.rows, "Agent trust tier row missing after upsert.");
      const before: DbAgentTrustTier = {
        ...current,
        workspace_name: workspace.name
      };

      const nextSuccessfulRuns = succeeded ? before.successful_runs + 1 : 0;
      const promoted =
        succeeded &&
        before.managed_by === "system" &&
        before.trust_tier === "restricted" &&
        nextSuccessfulRuns >= 3;
      const lastRunAt = new Date().toISOString();
      const promotedAt = promoted ? new Date().toISOString() : before.promoted_at;

      const updatedResult = await client.query<Omit<DbAgentTrustTier, "workspace_name">>(
        `update public.salvo_agent_trust_tiers
         set trust_tier = $3,
             successful_runs = $4,
             last_run_at = $5,
             promoted_at = $6,
             managed_by = $7
         where workspace_id = $1
           and agent_profile = $2
         returning
           workspace_id,
           agent_profile,
           trust_tier,
           successful_runs,
           last_run_at,
           promoted_at,
           managed_by,
           created_at,
           updated_at`,
        [
          workspaceId,
          agentProfile,
          promoted ? "standard" : before.trust_tier,
          nextSuccessfulRuns,
          lastRunAt,
          promotedAt,
          before.managed_by
        ]
      );
      const updated = this.singleOrThrow(updatedResult.rows, "Failed to update agent trust tier.");

      return {
        before,
        after: {
          ...updated,
          workspace_name: workspace.name
        },
        promoted
      };
    });
  }

  async createTask(input: CreateTaskInput): Promise<DbTask> {
    return this.withTransaction(async (client) => this.insertTask(client, input));
  }

  async createTaskIdempotent(input: CreateTaskInput, options: {
    idempotencyKey: string;
    requestFingerprint: string;
    ttlHours?: number;
  }): Promise<IdempotentResult<DbTask>> {
    return this.withTransaction(async (client) => {
      const idempotency = await this.beginIdempotentRequest<DbTask>(
        client,
        "task.create",
        options.idempotencyKey,
        options.requestFingerprint,
        options.ttlHours ?? 24
      );
      if (idempotency.kind === "replay") {
        return {
          resource: idempotency.responseJson as DbTask,
          duplicate: true,
          responseStatus: idempotency.responseStatus
        };
      }

      const task = await this.insertTask(client, input);
      await this.completeIdempotentRequest(client, "task.create", options.idempotencyKey, 201, task);
      return {
        resource: task,
        duplicate: false,
        responseStatus: 201
      };
    });
  }

  async createAuditEvent(input: CreateAuditEventInput): Promise<DbAuditEvent> {
    const result = await this.pool.query<DbAuditEvent>(
      `insert into public.audit_events (
         actor,
         action,
         target,
         metadata
       )
       values ($1, $2, $3, $4)
       returning *`,
      [input.actor, input.action, input.target ?? null, input.metadata ?? {}]
    );

    return this.singleOrThrow(result.rows, "Failed to create audit event.");
  }

  async listTasks(limit = 100): Promise<DbTask[]> {
    const result = await this.pool.query<DbTask>(
      `select *
       from public.salvo_tasks
       order by created_at desc
       limit $1`,
      [limit]
    );

    return result.rows;
  }

  async getTask(taskId: string): Promise<DbTask | null> {
    const result = await this.pool.query<DbTask>(
      `select * from public.salvo_tasks where id = $1 limit 1`,
      [taskId]
    );

    return result.rows[0] ?? null;
  }

  async transitionTaskStatus(taskId: string, nextStatus: TaskStatus): Promise<DbTask> {
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<DbTask>(
        `select * from public.salvo_tasks where id = $1 for update`,
        [taskId]
      );
      const current = this.singleOrThrow(currentResult.rows, `Task not found: ${taskId}`);
      assertTaskTransition(current.status, nextStatus);

      const updated = await client.query<DbTask>(
        `update public.salvo_tasks
         set status = $2
         where id = $1
         returning *`,
        [taskId, nextStatus]
      );

      return this.singleOrThrow(updated.rows, `Task update failed: ${taskId}`);
    });
  }

  async approveTask(taskId: string): Promise<DbTask> {
    return this.withTransaction(async (client) => {
      return this.approveTaskInTransaction(client, taskId);
    });
  }

  private async approveTaskInTransaction(client: PoolClient, taskId: string): Promise<DbTask> {
    const currentResult = await client.query<DbTask>(
      `select * from public.salvo_tasks where id = $1 for update`,
      [taskId]
    );
    const current = this.singleOrThrow(currentResult.rows, `Task not found: ${taskId}`);

    let nextStatus = current.status;
    if (current.status === "needs_review") {
      assertTaskTransition(current.status, "queued");
      nextStatus = "queued";
    }

    const result = await client.query<DbTask>(
      `update public.salvo_tasks
       set approved_at = now(),
           status = $2
       where id = $1
       returning *`,
      [taskId, nextStatus]
    );

    return this.singleOrThrow(result.rows, `Task not found: ${taskId}`);
  }

  async approveTaskIdempotent(taskId: string, options: {
    idempotencyKey: string;
    requestFingerprint: string;
    ttlHours?: number;
  }): Promise<IdempotentResult<DbTask>> {
    return this.withTransaction(async (client) => {
      const scope = `task.approve:${taskId}`;
      const idempotency = await this.beginIdempotentRequest<DbTask>(
        client,
        scope,
        options.idempotencyKey,
        options.requestFingerprint,
        options.ttlHours ?? 24
      );
      if (idempotency.kind === "replay") {
        return {
          resource: idempotency.responseJson as DbTask,
          duplicate: true,
          responseStatus: idempotency.responseStatus
        };
      }

      const task = await this.approveTaskInTransaction(client, taskId);
      await this.completeIdempotentRequest(client, scope, options.idempotencyKey, 200, task);
      return {
        resource: task,
        duplicate: false,
        responseStatus: 200
      };
    });
  }

  async createTaskChatSession(workspaceId?: string): Promise<DbTaskChatSession> {
    const resolvedWorkspaceId = workspaceId ?? (await this.ensureWorkspace()).id;
    const result = await this.pool.query<DbTaskChatSession>(
      `insert into public.salvo_task_chat_sessions (
         workspace_id,
         status
       )
       values ($1, 'active')
       returning *`,
      [resolvedWorkspaceId]
    );

    return this.singleOrThrow(result.rows, "Failed to create task chat session.");
  }

  async getTaskChatSession(sessionId: string): Promise<DbTaskChatSession | null> {
    const result = await this.pool.query<DbTaskChatSession>(
      `select *
       from public.salvo_task_chat_sessions
       where id = $1
       limit 1`,
      [sessionId]
    );

    return result.rows[0] ?? null;
  }

  async listTaskChatMessages(sessionId: string): Promise<DbTaskChatMessage[]> {
    const result = await this.pool.query<DbTaskChatMessage>(
      `select *
       from public.salvo_task_chat_messages
       where session_id = $1
       order by id asc`,
      [sessionId]
    );

    return result.rows;
  }

  async saveTaskChatTurn(input: {
    workspaceId?: string;
    sessionId?: string;
    userMessage: string;
    assistantResponse: string;
    proposedContract?: TaskChatProposal | null;
  }): Promise<{ session: DbTaskChatSession; assistantMessage: DbTaskChatMessage }> {
    return this.withTransaction(async (client) => {
      let session: DbTaskChatSession;
      if (input.sessionId) {
        const sessionResult = await client.query<DbTaskChatSession>(
          `select *
           from public.salvo_task_chat_sessions
           where id = $1
           for update`,
          [input.sessionId]
        );
        session = this.singleOrThrow(sessionResult.rows, `Task chat session not found: ${input.sessionId}`);
      } else {
        const workspaceId = input.workspaceId ?? (await this.ensureWorkspace()).id;
        const insertedSession = await client.query<DbTaskChatSession>(
          `insert into public.salvo_task_chat_sessions (
             workspace_id,
             status
           )
           values ($1, 'active')
           returning *`,
          [workspaceId]
        );
        session = this.singleOrThrow(insertedSession.rows, "Failed to create task chat session.");
      }

      await client.query(
        `insert into public.salvo_task_chat_messages (
           session_id,
           role,
           message_text
         )
         values ($1, 'user', $2)`,
        [session.id, input.userMessage]
      );

      const proposedContractJson = input.proposedContract
        ? JSON.stringify(input.proposedContract)
        : null;
      const assistantMessageResult = await client.query<DbTaskChatMessage>(
        `insert into public.salvo_task_chat_messages (
           session_id,
           role,
           message_text,
           proposed_contract_json
         )
         values ($1, 'assistant', $2, $3::jsonb)
         returning *`,
        [session.id, input.assistantResponse, proposedContractJson]
      );
      const assistantMessage = this.singleOrThrow(
        assistantMessageResult.rows,
        "Failed to append task chat assistant message."
      );

      const updatedSessionResult = await client.query<DbTaskChatSession>(
        `update public.salvo_task_chat_sessions
         set pending_proposal_json = $2::jsonb,
             status = 'active'
         where id = $1
         returning *`,
        [session.id, proposedContractJson]
      );
      const updatedSession = this.singleOrThrow(updatedSessionResult.rows, "Failed to update task chat session.");

      return {
        session: updatedSession,
        assistantMessage
      };
    });
  }

  private async approveTaskChatProposalInTransaction(
    client: PoolClient,
    sessionId: string,
    proposalOverride?: Record<string, unknown> | null
  ): Promise<{ session: DbTaskChatSession; task: DbTask; contract: DbContract }> {
    const sessionResult = await client.query<DbTaskChatSession>(
      `select *
       from public.salvo_task_chat_sessions
       where id = $1
       for update`,
      [sessionId]
    );
    const session = this.singleOrThrow(sessionResult.rows, `Task chat session not found: ${sessionId}`);

    if (session.approved_task_id && session.approved_contract_id) {
      const [taskResult, contractResult] = await Promise.all([
        client.query<DbTask>(
          `select *
           from public.salvo_tasks
           where id = $1
           limit 1`,
          [session.approved_task_id]
        ),
        client.query<DbContract>(
          `select *
           from public.salvo_contracts
           where id = $1
           limit 1`,
          [session.approved_contract_id]
        )
      ]);
      const task = this.singleOrThrow(taskResult.rows, `Task not found: ${session.approved_task_id}`);
      const contract = this.singleOrThrow(contractResult.rows, `Contract not found: ${session.approved_contract_id}`);
      return {
        session,
        task,
        contract
      };
    }

    const proposal = proposalOverride
      ? parseTaskChatProposal(proposalOverride)
      : parseTaskChatProposal(session.pending_proposal_json);
    if (!proposal) {
      throw new Error("No proposed contract is available for this task chat session.");
    }

    const createdTask = await this.insertTask(client, {
      workspaceId: session.workspace_id,
      title: proposal.title,
      request: proposal.request,
      requiresApproval: proposal.requires_approval
    });
    const approvedTask = await this.approveTaskInTransaction(client, createdTask.id);

    const versionResult = await client.query<{ version: number }>(
      `select coalesce(max(version), 0) + 1 as version
       from public.salvo_contracts
       where task_id = $1`,
      [approvedTask.id]
    );
    const version = versionResult.rows[0]?.version ?? 1;
    const contractId = randomUUID();
    const nowIso = new Date().toISOString();
    const contractJson = {
      ...proposal.contract_json,
      schema_version: proposal.contract_json.schema_version ?? 1,
      contract_id: contractId,
      task_id: approvedTask.id,
      workspace_id: session.workspace_id,
      created_at:
        typeof proposal.contract_json.created_at === "string"
          ? proposal.contract_json.created_at
          : nowIso,
      risk: proposal.risk
    };
    const contractResult = await client.query<DbContract>(
      `insert into public.salvo_contracts (
         id,
         task_id,
         version,
         status,
         risk,
         contract_json
       )
       values ($1, $2, $3, 'active', $4, $5)
       returning *`,
      [contractId, approvedTask.id, version, proposal.risk, contractJson]
    );
    const contract = this.singleOrThrow(contractResult.rows, "Failed to create contract from task chat proposal.");

    const updatedSessionResult = await client.query<DbTaskChatSession>(
      `update public.salvo_task_chat_sessions
       set status = 'approved',
           approved_task_id = $2,
           approved_contract_id = $3,
           approved_at = coalesce(approved_at, now()),
           pending_proposal_json = $4::jsonb
       where id = $1
       returning *`,
      [session.id, approvedTask.id, contract.id, JSON.stringify(proposal)]
    );
    const updatedSession = this.singleOrThrow(updatedSessionResult.rows, "Failed to approve task chat session.");

    return {
      session: updatedSession,
      task: approvedTask,
      contract
    };
  }

  async approveTaskChatProposal(
    sessionId: string,
    proposalOverride?: Record<string, unknown> | null
  ): Promise<{ session: DbTaskChatSession; task: DbTask; contract: DbContract }> {
    return this.withTransaction(async (client) =>
      this.approveTaskChatProposalInTransaction(client, sessionId, proposalOverride)
    );
  }

  async approveTaskChatProposalIdempotent(
    sessionId: string,
    options: {
      idempotencyKey: string;
      requestFingerprint: string;
      ttlHours?: number;
      proposalOverride?: Record<string, unknown> | null;
    }
  ): Promise<
    IdempotentResult<{
      session: DbTaskChatSession;
      task: DbTask;
      contract: DbContract;
    }>
  > {
    return this.withTransaction(async (client) => {
      const scope = `task.chat.approve:${sessionId}`;
      const idempotency = await this.beginIdempotentRequest<{
        session: DbTaskChatSession;
        task: DbTask;
        contract: DbContract;
      }>(
        client,
        scope,
        options.idempotencyKey,
        options.requestFingerprint,
        options.ttlHours ?? 24
      );
      if (idempotency.kind === "replay") {
        return {
          resource: idempotency.responseJson as {
            session: DbTaskChatSession;
            task: DbTask;
            contract: DbContract;
          },
          duplicate: true,
          responseStatus: idempotency.responseStatus
        };
      }

      const resource = await this.approveTaskChatProposalInTransaction(
        client,
        sessionId,
        options.proposalOverride
      );
      await this.completeIdempotentRequest(client, scope, options.idempotencyKey, 200, resource);
      return {
        resource,
        duplicate: false,
        responseStatus: 200
      };
    });
  }

  async rejectTask(taskId: string): Promise<DbTask> {
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<DbTask>(
        `select * from public.salvo_tasks where id = $1 for update`,
        [taskId]
      );
      const current = this.singleOrThrow(currentResult.rows, `Task not found: ${taskId}`);
      assertTaskTransition(current.status, "failed");

      const result = await client.query<DbTask>(
        `update public.salvo_tasks
         set status = 'failed',
             cancelled_at = now()
         where id = $1
         returning *`,
        [taskId]
      );

      return this.singleOrThrow(result.rows, `Task not found: ${taskId}`);
    });
  }

  async cancelTask(taskId: string): Promise<DbTask> {
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<DbTask>(
        `select * from public.salvo_tasks where id = $1 for update`,
        [taskId]
      );
      const current = this.singleOrThrow(currentResult.rows, `Task not found: ${taskId}`);
      assertTaskTransition(current.status, "cancelled");

      const result = await client.query<DbTask>(
        `update public.salvo_tasks
         set status = 'cancelled', cancelled_at = now()
         where id = $1
         returning *`,
        [taskId]
      );

      return this.singleOrThrow(result.rows, `Task not found: ${taskId}`);
    });
  }

  async claimNextTask(workerId: string): Promise<DbTask | null> {
    return this.withTransaction(async (client) => {
      const result = await client.query<DbTask>(
        `with candidate as (
           select id
           from public.salvo_tasks
           where status = 'queued'
             and cancelled_at is null
             and (requires_approval = false or approved_at is not null)
           order by created_at asc
           for update skip locked
           limit 1
         )
         update public.salvo_tasks t
         set status = 'planning',
             claimed_by = $1,
             claimed_at = now()
         from candidate
         where t.id = candidate.id
         returning t.*`,
        [workerId]
      );

      return result.rows[0] ?? null;
    });
  }

  async createContract(input: CreateContractInput): Promise<DbContract> {
    return this.withTransaction(async (client) => {
      const versionResult = await client.query<{ version: number }>(
        `select coalesce(max(version), 0) + 1 as version
         from public.salvo_contracts
         where task_id = $1`,
        [input.taskId]
      );

      const version = versionResult.rows[0]?.version ?? 1;

      const result = await client.query<DbContract>(
        `insert into public.salvo_contracts (
           id,
           task_id,
           version,
           status,
           risk,
           contract_json
         )
         values ($1, $2, $3, $4, $5, $6)
         returning *`,
        [randomUUID(), input.taskId, version, input.status, input.risk, input.contractJson]
      );

      return this.singleOrThrow(result.rows, "Failed to create contract.");
    });
  }

  async getContract(contractId: string): Promise<DbContract | null> {
    const result = await this.pool.query<DbContract>(
      `select * from public.salvo_contracts where id = $1 limit 1`,
      [contractId]
    );
    return result.rows[0] ?? null;
  }

  async createRun(input: CreateRunInput): Promise<DbRun> {
    return this.withTransaction(async (client) => {
      const attemptResult = await client.query<{ attempt_no: number }>(
        `select coalesce(max(attempt_no), 0) + 1 as attempt_no
         from public.salvo_runs
         where task_id = $1`,
        [input.taskId]
      );

      const attemptNo = attemptResult.rows[0]?.attempt_no ?? 1;

      const result = await client.query<DbRun>(
        `insert into public.salvo_runs (
           id,
           task_id,
           contract_id,
           attempt_no,
           agent_profile,
           status,
           worker_id
         )
         values ($1, $2, $3, $4, $5, 'created', $6)
         returning *`,
        [
          randomUUID(),
          input.taskId,
          input.contractId,
          attemptNo,
          input.agentProfile,
          input.workerId
        ]
      );

      return this.singleOrThrow(result.rows, "Failed to create run.");
    });
  }

  async getRun(runId: string): Promise<DbRun | null> {
    const result = await this.pool.query<DbRun>(
      `select * from public.salvo_runs where id = $1 limit 1`,
      [runId]
    );

    return result.rows[0] ?? null;
  }

  async listRuns(limit = 100): Promise<DbRun[]> {
    const result = await this.pool.query<DbRun>(
      `select * from public.salvo_runs order by created_at desc limit $1`,
      [limit]
    );

    return result.rows;
  }

  async listRunSummaries(limit = 100): Promise<DbRunSummary[]> {
    const result = await this.pool.query<DbRunSummary>(
      `select
         r.*,
         e.outcome as evaluation_outcome,
         e.hard_fail_reason,
         e.findings_json,
         coalesce(c.contract_json->>'family_key', concat('legacy_', substring(r.contract_id::text, 1, 12))) as contract_family_key,
         coalesce(c.contract_json->>'category', 'general') as contract_category,
         nullif(c.contract_json->>'subcategory', '') as contract_subcategory
       from public.salvo_runs r
       left join public.salvo_evaluations e on e.run_id = r.id
       left join public.salvo_contracts c on c.id = r.contract_id
       order by r.created_at desc
       limit $1`,
      [limit]
    );

    return result.rows;
  }

  async transitionRunStatus(
    runId: string,
    nextStatus: RunStatus,
    updates?: {
      workerId?: string;
      runnerPid?: number;
      exitReason?: RunExitReason;
      outcomeSummary?: string;
      score?: number;
      startedAt?: Date;
      heartbeatAt?: Date;
      endedAt?: Date;
    }
  ): Promise<DbRun> {
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<DbRun>(
        `select * from public.salvo_runs where id = $1 for update`,
        [runId]
      );
      const current = this.singleOrThrow(currentResult.rows, `Run not found: ${runId}`);

      assertRunTransition(current.status, nextStatus);

      const result = await client.query<DbRun>(
        `update public.salvo_runs
         set status = $2,
             worker_id = coalesce($3, worker_id),
             runner_pid = coalesce($4, runner_pid),
             exit_reason = coalesce($5, exit_reason),
             outcome_summary = coalesce($6, outcome_summary),
             score = coalesce($7, score),
             started_at = coalesce($8, started_at),
             heartbeat_at = coalesce($9, heartbeat_at),
             ended_at = coalesce($10, ended_at)
         where id = $1
         returning *`,
        [
          runId,
          nextStatus,
          updates?.workerId ?? null,
          updates?.runnerPid ?? null,
          updates?.exitReason ?? null,
          updates?.outcomeSummary ?? null,
          updates?.score ?? null,
          updates?.startedAt?.toISOString() ?? null,
          updates?.heartbeatAt?.toISOString() ?? null,
          updates?.endedAt?.toISOString() ?? null
        ]
      );

      return this.singleOrThrow(result.rows, `Failed to update run: ${runId}`);
    });
  }

  async recordHeartbeat(runId: string): Promise<void> {
    await this.pool.query(
      `update public.salvo_runs
       set heartbeat_at = now()
       where id = $1`,
      [runId]
    );
  }

  async appendRunEvent(
    runId: string,
    eventType: RunEventType,
    level: RunEventLevel,
    payloadJson: Record<string, unknown>
  ): Promise<DbRunEvent> {
    return this.withTransaction(async (client) => {
      await client.query(`select id from public.salvo_runs where id = $1 for update`, [runId]);

      const seqResult = await client.query<{ next_sequence: number }>(
        `select coalesce(max(sequence_no), 0) + 1 as next_sequence
         from public.salvo_run_events
         where run_id = $1`,
        [runId]
      );

      const sequenceNo = seqResult.rows[0]?.next_sequence ?? 1;

      const inserted = await client.query<DbRunEvent>(
        `insert into public.salvo_run_events (
           run_id,
           sequence_no,
           event_type,
           level,
           payload_json,
           schema_version
         )
         values ($1, $2, $3, $4, $5, 1)
         returning *`,
        [runId, sequenceNo, eventType, level, payloadJson]
      );

      return this.singleOrThrow(inserted.rows, "Failed to append event.");
    });
  }

  async listRunEvents(runId: string): Promise<DbRunEvent[]> {
    const result = await this.pool.query<DbRunEvent>(
      `select *
       from public.salvo_run_events
       where run_id = $1
       order by sequence_no asc`,
      [runId]
    );

    return result.rows;
  }

  async listRunUsageCosts(limit = 500): Promise<
    Array<{
      run_id: string;
      agent_profile: string;
      model: string;
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
      created_at: string;
    }>
  > {
    const result = await this.pool.query<{
      run_id: string;
      agent_profile: string;
      model: string;
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
      created_at: string;
    }>(
      `select
         r.id as run_id,
         r.agent_profile,
         coalesce(e.payload_json->>'model', 'unknown') as model,
         coalesce((e.payload_json->>'cost_usd')::double precision, 0) as cost_usd,
         coalesce((e.payload_json->>'input_tokens')::integer, 0) as input_tokens,
         coalesce((e.payload_json->>'output_tokens')::integer, 0) as output_tokens,
         r.created_at
       from public.salvo_runs r
       left join lateral (
         select payload_json
         from public.salvo_run_events
         where run_id = r.id
           and event_type = 'usage.reported'
         order by sequence_no desc
         limit 1
       ) e on true
       order by r.created_at desc
       limit $1`,
      [limit]
    );

    return result.rows;
  }

  async listBudgetLimits(): Promise<DbBudgetLimit[]> {
    const result = await this.pool.query<DbBudgetLimit>(
      `select
         id,
         workspace_id,
         contract_family_key,
         limit_usd::double precision as limit_usd,
         created_at,
         updated_at
       from public.salvo_budget_limits
       order by workspace_id asc, contract_family_key asc nulls first`
    );

    return result.rows;
  }

  async upsertBudgetLimit(input: {
    workspaceId: string;
    contractFamilyKey?: string | null;
    limitUsd: number;
  }): Promise<DbBudgetLimit> {
    const contractFamilyKey = input.contractFamilyKey?.trim() ? input.contractFamilyKey.trim() : null;

    const result = await this.pool.query<DbBudgetLimit>(
      `with upserted as (
         insert into public.salvo_budget_limits (
           workspace_id,
           contract_family_key,
           limit_usd
         )
         select $1, $2, $3
         where $2 is not null
         on conflict (workspace_id, contract_family_key)
         where contract_family_key is not null
         do update set limit_usd = excluded.limit_usd
         returning id, workspace_id, contract_family_key, limit_usd, created_at, updated_at
       ), workspace_scope as (
         insert into public.salvo_budget_limits (
           workspace_id,
           contract_family_key,
           limit_usd
         )
         select $1, null, $3
         where $2 is null
         on conflict (workspace_id)
         where contract_family_key is null
         do update set limit_usd = excluded.limit_usd
         returning id, workspace_id, contract_family_key, limit_usd, created_at, updated_at
       )
       select
         id,
         workspace_id,
         contract_family_key,
         limit_usd::double precision as limit_usd,
         created_at,
         updated_at
       from (
         select * from upserted
         union all
         select * from workspace_scope
       ) rowset
       limit 1`,
      [input.workspaceId, contractFamilyKey, input.limitUsd]
    );

    return this.singleOrThrow(result.rows, "Failed to save budget limit.");
  }

  async listBudgetStatuses(): Promise<DbBudgetStatus[]> {
    const result = await this.pool.query<DbBudgetStatus>(
      `with usage_rows as (
         select
           t.workspace_id,
           coalesce(
             c.contract_json->>'family_key',
             concat('legacy_', substring(r.contract_id::text, 1, 12))
           ) as contract_family_key,
           coalesce((e.payload_json->>'cost_usd')::double precision, 0) as cost_usd,
           e.created_at
         from public.salvo_runs r
         join public.salvo_tasks t on t.id = r.task_id
         left join public.salvo_contracts c on c.id = r.contract_id
         join lateral (
           select payload_json, created_at
           from public.salvo_run_events
           where run_id = r.id
             and event_type = 'usage.reported'
           order by sequence_no desc
           limit 1
         ) e on true
       ), workspace_spend as (
         select
           workspace_id,
           sum(cost_usd) as spent_usd,
           max(created_at) as last_usage_at
         from usage_rows
         group by workspace_id
       ), family_spend as (
         select
           workspace_id,
           contract_family_key,
           sum(cost_usd) as spent_usd,
           max(created_at) as last_usage_at
         from usage_rows
         group by workspace_id, contract_family_key
       )
       select
         bl.id,
         bl.workspace_id,
         w.name as workspace_name,
         bl.contract_family_key,
         bl.limit_usd::double precision as limit_usd,
         case
           when bl.contract_family_key is null then 'workspace'
           else 'family'
         end as scope,
         coalesce(
           case
             when bl.contract_family_key is null then ws.spent_usd
             else fs.spent_usd
           end,
           0
         ) as spent_usd,
         (
           bl.limit_usd::double precision -
           coalesce(
             case
               when bl.contract_family_key is null then ws.spent_usd
               else fs.spent_usd
             end,
             0
           )
         ) as remaining_usd,
         case
           when bl.contract_family_key is null then ws.last_usage_at
           else fs.last_usage_at
         end as last_usage_at,
         bl.created_at,
         bl.updated_at
       from public.salvo_budget_limits bl
       join public.salvo_workspaces w on w.id = bl.workspace_id
       left join workspace_spend ws on ws.workspace_id = bl.workspace_id
       left join family_spend fs
         on fs.workspace_id = bl.workspace_id
        and fs.contract_family_key = bl.contract_family_key
       order by w.name asc, bl.contract_family_key asc nulls first`
    );

    return result.rows.map((row) => ({
      ...row,
      spent_usd: Number(row.spent_usd.toFixed(6)),
      remaining_usd: Number(row.remaining_usd.toFixed(6))
    }));
  }

  async listApplicableBudgetStatuses(
    workspaceId: string,
    contractFamilyKey: string
  ): Promise<DbBudgetStatus[]> {
    const result = await this.pool.query<DbBudgetStatus>(
      `with usage_rows as (
         select
           t.workspace_id,
           coalesce(
             c.contract_json->>'family_key',
             concat('legacy_', substring(r.contract_id::text, 1, 12))
           ) as contract_family_key,
           coalesce((e.payload_json->>'cost_usd')::double precision, 0) as cost_usd,
           e.created_at
         from public.salvo_runs r
         join public.salvo_tasks t on t.id = r.task_id
         left join public.salvo_contracts c on c.id = r.contract_id
         join lateral (
           select payload_json, created_at
           from public.salvo_run_events
           where run_id = r.id
             and event_type = 'usage.reported'
           order by sequence_no desc
           limit 1
         ) e on true
       ), workspace_spend as (
         select
           workspace_id,
           sum(cost_usd) as spent_usd,
           max(created_at) as last_usage_at
         from usage_rows
         group by workspace_id
       ), family_spend as (
         select
           workspace_id,
           contract_family_key,
           sum(cost_usd) as spent_usd,
           max(created_at) as last_usage_at
         from usage_rows
         group by workspace_id, contract_family_key
       )
       select
         bl.id,
         bl.workspace_id,
         w.name as workspace_name,
         bl.contract_family_key,
         bl.limit_usd::double precision as limit_usd,
         case
           when bl.contract_family_key is null then 'workspace'
           else 'family'
         end as scope,
         coalesce(
           case
             when bl.contract_family_key is null then ws.spent_usd
             else fs.spent_usd
           end,
           0
         ) as spent_usd,
         (
           bl.limit_usd::double precision -
           coalesce(
             case
               when bl.contract_family_key is null then ws.spent_usd
               else fs.spent_usd
             end,
             0
           )
         ) as remaining_usd,
         case
           when bl.contract_family_key is null then ws.last_usage_at
           else fs.last_usage_at
         end as last_usage_at,
         bl.created_at,
         bl.updated_at
       from public.salvo_budget_limits bl
       join public.salvo_workspaces w on w.id = bl.workspace_id
       left join workspace_spend ws on ws.workspace_id = bl.workspace_id
       left join family_spend fs
         on fs.workspace_id = bl.workspace_id
        and fs.contract_family_key = bl.contract_family_key
       where bl.workspace_id = $1
         and (
           bl.contract_family_key is null
           or bl.contract_family_key = $2
         )
       order by bl.contract_family_key asc nulls first`,
      [workspaceId, contractFamilyKey]
    );

    return result.rows.map((row) => ({
      ...row,
      spent_usd: Number(row.spent_usd.toFixed(6)),
      remaining_usd: Number(row.remaining_usd.toFixed(6))
    }));
  }

  async createArtifact(params: {
    runId: string;
    taskId: string;
    artifactType: string;
    path: string;
    metadataJson?: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `insert into public.salvo_artifacts (
         run_id,
         task_id,
         artifact_type,
         path,
         metadata_json
       )
       values ($1, $2, $3, $4, $5)`,
      [
        params.runId,
        params.taskId,
        params.artifactType,
        params.path,
        params.metadataJson ?? {}
      ]
    );
  }

  async listArtifactsForRun(runId: string): Promise<DbArtifact[]> {
    const result = await this.pool.query<DbArtifact>(
      `select *
       from public.salvo_artifacts
       where run_id = $1
       order by created_at asc`,
      [runId]
    );

    return result.rows;
  }

  async getArtifact(artifactId: string): Promise<DbArtifact | null> {
    const result = await this.pool.query<DbArtifact>(
      `select *
       from public.salvo_artifacts
       where id = $1
       limit 1`,
      [artifactId]
    );

    return result.rows[0] ?? null;
  }

  async findStaleRuns(staleAfterSeconds = 30): Promise<DbRun[]> {
    const result = await this.pool.query<DbRun>(
      `select *
       from public.salvo_runs
       where status in ('created', 'provisioning', 'starting', 'running', 'evaluating')
         and coalesce(heartbeat_at, started_at, created_at) < now() - ($1::text || ' seconds')::interval
       order by created_at asc`,
      [staleAfterSeconds]
    );

    return result.rows;
  }

  async scheduleRetryFromStaleRun(
    staleRunId: string,
    workerId: string,
    maxAttempts = 2
  ): Promise<{ disposition: "scheduled" | "exhausted"; retryRun?: DbRun }> {
    return this.withTransaction(async (client) => {
      const staleResult = await client.query<DbRun>(
        `select * from public.salvo_runs where id = $1 for update`,
        [staleRunId]
      );
      const staleRun = this.singleOrThrow(staleResult.rows, `Run not found: ${staleRunId}`);

      if (TERMINAL_RUN_STATUSES.has(staleRun.status)) {
        return { disposition: "exhausted" };
      }

      await client.query(
        `update public.salvo_runs
         set status = 'failed',
             exit_reason = 'stale_runner',
             outcome_summary = 'Run marked stale by orchestrator.',
             ended_at = now()
         where id = $1`,
        [staleRunId]
      );

      if (staleRun.attempt_no >= maxAttempts) {
        await client.query(
          `update public.salvo_tasks
           set status = 'failed'
           where id = $1 and status in ('planning','running','blocked')`,
          [staleRun.task_id]
        );
        return { disposition: "exhausted" };
      }

      const retryResult = await client.query<DbRun>(
        `insert into public.salvo_runs (
           id,
           task_id,
           contract_id,
           attempt_no,
           agent_profile,
           status,
           worker_id
         )
         values ($1, $2, $3, $4, $5, 'created', $6)
         returning *`,
        [
          randomUUID(),
          staleRun.task_id,
          staleRun.contract_id,
          staleRun.attempt_no + 1,
          staleRun.agent_profile,
          workerId
        ]
      );

      const retryRun = this.singleOrThrow(retryResult.rows, "Failed to create retry run.");
      return {
        disposition: "scheduled",
        retryRun
      };
    });
  }

  async requestRetryForRun(runId: string): Promise<{
    task: DbTask;
    sourceRun: DbRun;
  }> {
    return this.withTransaction(async (client) => {
      const runResult = await client.query<DbRun>(
        `select * from public.salvo_runs where id = $1 for update`,
        [runId]
      );
      const sourceRun = this.singleOrThrow(runResult.rows, `Run not found: ${runId}`);

      if (!RETRYABLE_RUN_STATUSES.has(sourceRun.status)) {
        throw new Error(
          `Run ${runId} is not retryable from status ${sourceRun.status}.`
        );
      }

      const taskResult = await client.query<DbTask>(
        `select * from public.salvo_tasks where id = $1 for update`,
        [sourceRun.task_id]
      );
      const task = this.singleOrThrow(
        taskResult.rows,
        `Task not found for run: ${sourceRun.task_id}`
      );

      assertTaskTransition(task.status, "queued");

      const updatedTaskResult = await client.query<DbTask>(
        `update public.salvo_tasks
         set status = 'queued',
             claimed_by = null,
             claimed_at = null,
             cancelled_at = null
         where id = $1
         returning *`,
        [task.id]
      );
      const updatedTask = this.singleOrThrow(updatedTaskResult.rows, "Task retry update failed.");

      const seqResult = await client.query<{ next_sequence: number }>(
        `select coalesce(max(sequence_no), 0) + 1 as next_sequence
         from public.salvo_run_events
         where run_id = $1`,
        [sourceRun.id]
      );

      const sequenceNo = seqResult.rows[0]?.next_sequence ?? 1;
      await client.query(
        `insert into public.salvo_run_events (
           run_id,
           sequence_no,
           event_type,
           level,
           payload_json,
           schema_version
         )
         values ($1, $2, 'run.retry_requested', 'info', $3::jsonb, 1)`,
        [
          sourceRun.id,
          sequenceNo,
          JSON.stringify({
            requested_at: new Date().toISOString(),
            task_id: task.id
          })
        ]
      );

      return {
        task: updatedTask,
        sourceRun
      };
    });
  }

  async cancelRun(runId: string): Promise<{
    run: DbRun;
    task: DbTask;
  }> {
    return this.withTransaction(async (client) => {
      const runResult = await client.query<DbRun>(
        `select * from public.salvo_runs where id = $1 for update`,
        [runId]
      );
      const run = this.singleOrThrow(runResult.rows, `Run not found: ${runId}`);

      if (!isTerminalRunStatus(run.status)) {
        assertRunTransition(run.status, "cancelled");
      }

      const updatedRunResult = await client.query<DbRun>(
        `update public.salvo_runs
         set status = 'cancelled',
             exit_reason = coalesce(exit_reason, 'cancelled'),
             outcome_summary = coalesce(outcome_summary, 'Cancelled by user request.'),
             ended_at = coalesce(ended_at, now()),
             cancellation_requested_at = null
         where id = $1
         returning *`,
        [runId]
      );
      const updatedRun = this.singleOrThrow(updatedRunResult.rows, `Run update failed: ${runId}`);

      const seqResult = await client.query<{ next_sequence: number }>(
        `select coalesce(max(sequence_no), 0) + 1 as next_sequence
         from public.salvo_run_events
         where run_id = $1`,
        [updatedRun.id]
      );
      const sequenceNo = seqResult.rows[0]?.next_sequence ?? 1;

      await client.query(
        `insert into public.salvo_run_events (
           run_id,
           sequence_no,
           event_type,
           level,
           payload_json,
           schema_version
         )
         values ($1, $2, 'run.cancelled', 'info', $3::jsonb, 1)`,
        [
          updatedRun.id,
          sequenceNo,
          JSON.stringify({
            cancelled_at: new Date().toISOString()
          })
        ]
      );

      const taskResult = await client.query<DbTask>(
        `select * from public.salvo_tasks where id = $1 for update`,
        [updatedRun.task_id]
      );
      const task = this.singleOrThrow(taskResult.rows, `Task not found: ${updatedRun.task_id}`);

      let updatedTask = task;
      if (task.status !== "cancelled") {
        assertTaskTransition(task.status, "cancelled");
        const updatedTaskResult = await client.query<DbTask>(
          `update public.salvo_tasks
           set status = 'cancelled',
               cancelled_at = now()
           where id = $1
           returning *`,
          [task.id]
        );
        updatedTask = this.singleOrThrow(updatedTaskResult.rows, `Task update failed: ${task.id}`);
      }

      return {
        run: updatedRun,
        task: updatedTask
      };
    });
  }

  async requestRunCancellation(runId: string): Promise<DbRun> {
    return this.withTransaction(async (client) => {
      const runResult = await client.query<DbRun>(
        `select * from public.salvo_runs where id = $1 for update`,
        [runId]
      );
      const run = this.singleOrThrow(runResult.rows, `Run not found: ${runId}`);

      if (!CANCELLABLE_RUN_STATUSES.has(run.status)) {
        throw new Error(`Run ${runId} cannot be cancelled from status ${run.status}.`);
      }

      const updatedRunResult = await client.query<DbRun>(
        `update public.salvo_runs
         set cancellation_requested_at = now()
         where id = $1
         returning *`,
        [runId]
      );
      const updatedRun = this.singleOrThrow(updatedRunResult.rows, `Run update failed: ${runId}`);

      const seqResult = await client.query<{ next_sequence: number }>(
        `select coalesce(max(sequence_no), 0) + 1 as next_sequence
         from public.salvo_run_events
         where run_id = $1`,
        [updatedRun.id]
      );
      const sequenceNo = seqResult.rows[0]?.next_sequence ?? 1;

      await client.query(
        `insert into public.salvo_run_events (
           run_id,
           sequence_no,
           event_type,
           level,
           payload_json,
           schema_version
         )
         values ($1, $2, 'run.cancel_requested', 'warn', $3::jsonb, 1)`,
        [
          updatedRun.id,
          sequenceNo,
          JSON.stringify({
            requested_at: new Date().toISOString()
          })
        ]
      );

      return updatedRun;
    });
  }

  async listCancellationRequestedRuns(limit = 50): Promise<DbRun[]> {
    const result = await this.pool.query<DbRun>(
      `select *
       from public.salvo_runs
       where status in ('created', 'provisioning', 'starting', 'running', 'evaluating')
         and cancellation_requested_at is not null
       order by cancellation_requested_at asc
       limit $1`,
      [limit]
    );

    return result.rows;
  }

  async findOrphanedTasks(orphanAfterSeconds = 120, limit = 50): Promise<DbTask[]> {
    const result = await this.pool.query<DbTask>(
      `select t.*
       from public.salvo_tasks t
       where t.status = 'planning'
         and t.claimed_at is not null
         and t.claimed_at < now() - ($1::text || ' seconds')::interval
         and not exists (
           select 1
           from public.salvo_runs r
           where r.task_id = t.id
         )
       order by t.claimed_at asc
       limit $2`,
      [orphanAfterSeconds, limit]
    );

    return result.rows;
  }

  async recoverOrphanedTask(taskId: string): Promise<DbTask> {
    return this.withTransaction(async (client) => {
      const taskResult = await client.query<DbTask>(
        `select *
         from public.salvo_tasks
         where id = $1
         for update`,
        [taskId]
      );
      const task = this.singleOrThrow(taskResult.rows, `Task not found: ${taskId}`);

      if (task.status !== "planning") {
        return task;
      }

      const runCountResult = await client.query<{ count: string }>(
        `select count(*)::text as count
         from public.salvo_runs
         where task_id = $1`,
        [taskId]
      );
      const runCount = Number(runCountResult.rows[0]?.count ?? "0");
      if (runCount > 0) {
        return task;
      }

      assertTaskTransition(task.status, "queued");
      const updatedResult = await client.query<DbTask>(
        `update public.salvo_tasks
         set status = 'queued',
             claimed_by = null,
             claimed_at = null,
             cancelled_at = null
         where id = $1
         returning *`,
        [taskId]
      );
      return this.singleOrThrow(updatedResult.rows, `Task update failed: ${taskId}`);
    });
  }

  async recordEvaluation(input: RecordEvaluationInput): Promise<DbEvaluation> {
    const result = await this.pool.query<DbEvaluation>(
      `insert into public.salvo_evaluations (
         run_id,
         contract_id,
         passed,
         score,
         outcome,
         hard_fail_reason,
         findings_json
       )
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)
       on conflict (run_id)
       do update
         set passed = excluded.passed,
             score = excluded.score,
             outcome = excluded.outcome,
            hard_fail_reason = excluded.hard_fail_reason,
            findings_json = excluded.findings_json
       returning *`,
      [
        input.runId,
        input.contractId,
        input.passed,
        input.score,
        input.outcome,
        input.hardFailReason ?? null,
        JSON.stringify(input.findings)
      ]
    );

    return this.singleOrThrow(result.rows, "Failed to record evaluation.");
  }

  async getRunFinalPayload(runId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query<{ payload_json: Record<string, unknown> }>(
      `select payload_json
       from public.salvo_run_events
       where run_id = $1
         and event_type = 'run.final_payload'
       order by sequence_no desc
       limit 1`,
      [runId]
    );

    return result.rows[0]?.payload_json ?? null;
  }

  async getRunWithContext(runId: string): Promise<{
    run: DbRun;
    task: DbTask;
    contract: DbContract;
  } | null> {
    const run = await this.getRun(runId);
    if (!run) {
      return null;
    }

    const task = await this.getTask(run.task_id);
    const contract = await this.getContract(run.contract_id);
    if (!task || !contract) {
      return null;
    }

    return { run, task, contract };
  }

  async createResearchDocument(input: CreateResearchInput): Promise<void> {
    await this.pool.query(
      `insert into public.salvo_research_documents (
         workspace_id,
         title,
         topic,
         body_markdown,
         source_run_ids,
         confidence,
         review_status
       )
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.workspaceId,
        input.title,
        input.topic,
        input.bodyMarkdown,
        input.sourceRunIds,
        input.confidence,
        input.reviewStatus
      ]
    );
  }

  async createMemory(input: CreateMemoryInput): Promise<void> {
    await this.pool.query(
      `insert into public.salvo_memories (
         workspace_id,
         source_run_ids,
         contract_family_key,
         memory_type,
         title,
         summary,
         body_markdown,
         tags,
         confidence,
         review_status
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.workspaceId,
        input.sourceRunIds,
        input.contractFamilyKey ?? null,
        input.memoryType,
        input.title,
        input.summary,
        input.bodyMarkdown,
        input.tags,
        input.confidence,
        input.reviewStatus
      ]
    );
  }

  async listResearchIngestionCandidates(limit = 50): Promise<ResearchIngestionCandidate[]> {
    const result = await this.pool.query<ResearchIngestionCandidate>(
      `select
         r.id as run_id,
         t.workspace_id,
         r.task_id,
         r.contract_id,
         r.status as run_status,
         e.outcome as evaluation_outcome,
         e.score as evaluation_score,
         coalesce(events.policy_denial_count, 0) as policy_denial_count,
         coalesce(events.event_count, 0) as event_count,
         coalesce(events.event_types, array[]::text[]) as source_event_types,
         coalesce(c.contract_json->>'family_key', concat('legacy_', substring(c.id::text, 1, 12))) as contract_family_key,
         coalesce(c.contract_json->>'category', 'general') as contract_category,
         nullif(c.contract_json->>'subcategory', '') as contract_subcategory,
         jsonb_build_object(
           'evaluation_outcome', e.outcome,
           'evaluation_score', e.score,
           'hard_fail_reason', e.hard_fail_reason,
           'findings', e.findings_json
         ) as source_summary
       from public.salvo_runs r
       join public.salvo_tasks t on t.id = r.task_id
       join public.salvo_contracts c on c.id = r.contract_id
       join public.salvo_evaluations e on e.run_id = r.id
       left join lateral (
         select
           count(*)::integer as event_count,
           count(*) filter (where event_type = 'policy.denied')::integer as policy_denial_count,
           coalesce(array_agg(distinct event_type), array[]::text[]) as event_types
         from public.salvo_run_events
         where run_id = r.id
       ) events on true
       where r.status in ('completed', 'failed')
         and not exists (
           select 1
           from public.salvo_research_ingestions i
           where i.run_id = r.id
         )
       order by coalesce(r.ended_at, r.updated_at, r.created_at) asc
       limit $1`,
      [limit]
    );

    return result.rows;
  }

  async recordResearchIngestion(candidate: ResearchIngestionCandidate): Promise<void> {
    await this.pool.query(
      `insert into public.salvo_research_ingestions (
         run_id,
         workspace_id,
         task_id,
         contract_id,
         contract_family_key,
         contract_category,
         contract_subcategory,
         run_status,
         evaluation_outcome,
         score,
         policy_denial_count,
         event_count,
         source_event_types,
         source_json
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
       on conflict (run_id)
       do nothing`,
      [
        candidate.run_id,
        candidate.workspace_id,
        candidate.task_id,
        candidate.contract_id,
        candidate.contract_family_key,
        candidate.contract_category,
        candidate.contract_subcategory,
        candidate.run_status,
        candidate.evaluation_outcome,
        candidate.evaluation_score,
        candidate.policy_denial_count,
        candidate.event_count,
        candidate.source_event_types,
        JSON.stringify(candidate.source_summary)
      ]
    );
  }

  async listPendingExperimentFamilies(
    minSampleSize: number,
    limit = 20
  ): Promise<
    Array<{
      workspace_id: string;
      contract_family_key: string;
      contract_category: string;
      contract_subcategory: string | null;
      pending_count: number;
    }>
  > {
    const result = await this.pool.query<{
      workspace_id: string;
      contract_family_key: string;
      contract_category: string;
      contract_subcategory: string | null;
      pending_count: number;
    }>(
      `select
         workspace_id,
         contract_family_key,
         contract_category,
         contract_subcategory,
         count(*)::integer as pending_count
       from public.salvo_research_ingestions
       where experiment_id is null
       group by workspace_id, contract_family_key, contract_category, contract_subcategory
       having count(*) >= $1
       order by max(ingested_at) asc
       limit $2`,
      [minSampleSize, limit]
    );

    return result.rows;
  }

  async listPendingFamilyIngestions(
    workspaceId: string,
    familyKey: string,
    category: string,
    subcategory: string | null,
    limit = 500
  ): Promise<
    Array<{
      run_id: string;
      evaluation_outcome: "passed" | "failed" | "hard_failed";
      score: number;
      run_status: "completed" | "failed";
      policy_denial_count: number;
      event_count: number;
      source_event_types: string[];
      source_json: Record<string, unknown>;
      ingested_at: string;
    }>
  > {
    const result = await this.pool.query<{
      run_id: string;
      evaluation_outcome: "passed" | "failed" | "hard_failed";
      score: number;
      run_status: "completed" | "failed";
      policy_denial_count: number;
      event_count: number;
      source_event_types: string[];
      source_json: Record<string, unknown>;
      ingested_at: string;
    }>(
      `select
         run_id,
         evaluation_outcome,
         score,
         run_status,
         policy_denial_count,
         event_count,
         source_event_types,
         source_json,
         ingested_at
       from public.salvo_research_ingestions
       where workspace_id = $1
         and contract_family_key = $2
         and contract_category = $3
         and contract_subcategory is not distinct from $4
         and experiment_id is null
       order by ingested_at asc
       limit $5`,
      [workspaceId, familyKey, category, subcategory, limit]
    );

    return result.rows;
  }

  async createResearchExperiment(input: {
    workspaceId: string;
    familyKey: string;
    category: string;
    subcategory: string | null;
    sampleSize: number;
    sourceDigest: string;
    sourceRunIds: string[];
    metricsJson: Record<string, unknown>;
    bodyMarkdown: string;
    confidence: number;
    reviewStatus: DbResearchReviewStatus;
  }): Promise<{ experiment: DbResearchExperiment; created: boolean }> {
    const inserted = await this.pool.query<DbResearchExperiment>(
      `insert into public.salvo_research_experiments (
         workspace_id,
         contract_family_key,
         contract_category,
         contract_subcategory,
         sample_size,
         source_digest,
         source_run_ids,
         metrics_json,
         body_markdown,
         confidence,
         review_status
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
       on conflict (workspace_id, contract_family_key, source_digest)
       do nothing
       returning *`,
      [
        input.workspaceId,
        input.familyKey,
        input.category,
        input.subcategory,
        input.sampleSize,
        input.sourceDigest,
        input.sourceRunIds,
        JSON.stringify(input.metricsJson),
        input.bodyMarkdown,
        input.confidence,
        input.reviewStatus
      ]
    );

    if (inserted.rows[0]) {
      return {
        experiment: inserted.rows[0],
        created: true
      };
    }

    const existing = await this.pool.query<DbResearchExperiment>(
      `select *
       from public.salvo_research_experiments
       where workspace_id = $1
         and contract_family_key = $2
         and source_digest = $3
       limit 1`,
      [input.workspaceId, input.familyKey, input.sourceDigest]
    );

    return {
      experiment: this.singleOrThrow(existing.rows, "Research experiment dedupe lookup failed."),
      created: false
    };
  }

  async attachIngestionsToExperiment(experimentId: string, runIds: string[]): Promise<void> {
    if (runIds.length === 0) {
      return;
    }

    await this.pool.query(
      `update public.salvo_research_ingestions
       set experiment_id = $2
       where run_id = any($1::uuid[])
         and experiment_id is null`,
      [runIds, experimentId]
    );
  }

  async createResearchFinding(input: {
    experimentId: string;
    workspaceId: string;
    findingType: string;
    title: string;
    bodyMarkdown: string;
    confidence: number;
    metadataJson?: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `insert into public.salvo_research_findings (
         experiment_id,
         workspace_id,
         finding_type,
         title,
         body_markdown,
         confidence,
         metadata_json
       )
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        input.experimentId,
        input.workspaceId,
        input.findingType,
        input.title,
        input.bodyMarkdown,
        input.confidence,
        JSON.stringify(input.metadataJson ?? {})
      ]
    );
  }

  async listAcceptedUnpublishedResearchExperiments(limit = 50): Promise<DbResearchExperiment[]> {
    const result = await this.pool.query<DbResearchExperiment>(
      `select *
       from public.salvo_research_experiments
       where review_status = 'accepted'
         and published_at is null
       order by created_at asc
       limit $1`,
      [limit]
    );

    return result.rows;
  }

  async markResearchExperimentPublished(experimentId: string): Promise<void> {
    await this.pool.query(
      `update public.salvo_research_experiments
       set published_at = now()
       where id = $1`,
      [experimentId]
    );
  }

  async publishAcceptedResearchExperiment(experimentId: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const experimentResult = await client.query<DbResearchExperiment>(
        `select *
         from public.salvo_research_experiments
         where id = $1
         for update`,
        [experimentId]
      );
      const experiment = experimentResult.rows[0];
      if (!experiment) {
        return false;
      }
      if (experiment.review_status !== "accepted" || experiment.published_at) {
        return false;
      }

      const memoryInsertResult = await client.query<{ id: string }>(
        `insert into public.salvo_memories (
           workspace_id,
           source_run_ids,
           contract_family_key,
           memory_type,
           title,
           summary,
           body_markdown,
           tags,
           confidence,
           review_status
         )
         values ($1, $2, $3, 'research_experiment', $4, $5, $6, $7, $8, 'accepted')
         returning id`,
        [
          experiment.workspace_id,
          experiment.source_run_ids,
          experiment.contract_family_key,
          `Experiment memory: ${experiment.contract_category}${
            experiment.contract_subcategory ? `/${experiment.contract_subcategory}` : ""
          }`,
          `Deterministic experiment from ${experiment.sample_size} runs (experiment ${experiment.id}).`,
          experiment.body_markdown,
          [
            "research",
            "experiment",
            `experiment:${experiment.id}`,
            `family:${experiment.contract_family_key}`,
            `category:${experiment.contract_category}`
          ],
          experiment.confidence
        ]
      );
      const memoryId = this.singleOrThrow(
        memoryInsertResult.rows,
        `Memory publish insert failed for experiment ${experiment.id}`
      ).id;

      await client.query(
        `update public.salvo_research_findings
         set published_memory_id = $2
         where experiment_id = $1
           and published_memory_id is null`,
        [experiment.id, memoryId]
      );

      await client.query(
        `update public.salvo_research_experiments
         set published_at = now()
         where id = $1`,
        [experiment.id]
      );

      return true;
    });
  }

  async getRunDetail(runId: string): Promise<{
    run: DbRun;
    task: DbTask;
    contract: DbContract;
    evaluation: DbEvaluation | null;
  } | null> {
    const context = await this.getRunWithContext(runId);
    if (!context) {
      return null;
    }

    const evaluationResult = await this.pool.query<DbEvaluation>(
      `select * from public.salvo_evaluations where run_id = $1 limit 1`,
      [runId]
    );

    return {
      ...context,
      evaluation: evaluationResult.rows[0] ?? null
    };
  }

  async listResearchDocumentsForRun(runId: string): Promise<
    {
      id: string;
      title: string;
      confidence: number;
      review_status: "unreviewed" | "accepted" | "rejected";
      created_at: string;
    }[]
  > {
    const result = await this.pool.query<{
      id: string;
      title: string;
      confidence: number;
      review_status: "unreviewed" | "accepted" | "rejected";
      created_at: string;
    }>(
      `select id, title, confidence, review_status, created_at
       from (
         select
           id,
           title,
           confidence,
           review_status,
           created_at,
           source_run_ids
         from public.salvo_research_documents
         union all
         select
           id,
           concat(
             'Experiment: ',
             contract_category,
             coalesce(concat('/', contract_subcategory), '')
           ) as title,
           confidence,
           review_status,
           created_at,
           source_run_ids
         from public.salvo_research_experiments
       ) entries
       where $1 = any(source_run_ids)
       order by created_at desc`,
      [runId]
    );

    return result.rows;
  }

  async upsertDaemonHeartbeat(
    daemonType: DaemonType,
    daemonId: string,
    metadataJson?: Record<string, unknown>
  ): Promise<DbDaemonHeartbeat> {
    const result = await this.pool.query<DbDaemonHeartbeat>(
      `insert into public.salvo_daemon_heartbeats (
         daemon_type,
         daemon_id,
         heartbeat_at,
         metadata_json
       )
       values ($1, $2, now(), $3::jsonb)
       on conflict (daemon_type)
       do update
         set daemon_id = excluded.daemon_id,
             heartbeat_at = now(),
             metadata_json = excluded.metadata_json
       returning *`,
      [daemonType, daemonId, JSON.stringify(metadataJson ?? {})]
    );

    return this.singleOrThrow(result.rows, "Failed to upsert daemon heartbeat.");
  }

  async getDaemonHeartbeat(daemonType: DaemonType): Promise<DbDaemonHeartbeat | null> {
    const result = await this.pool.query<DbDaemonHeartbeat>(
      `select *
       from public.salvo_daemon_heartbeats
       where daemon_type = $1
       limit 1`,
      [daemonType]
    );

    return result.rows[0] ?? null;
  }

  async listIntegrationConfigs(): Promise<DbIntegrationConfig[]> {
    const result = await this.pool.query<DbIntegrationConfig>(
      `select *
       from public.salvo_integration_configs
       order by integration_key asc`
    );

    return result.rows;
  }

  async listSkillSettings(workspaceId: string): Promise<DbSkillSetting[]> {
    const result = await this.pool.query<DbSkillSetting>(
      `select *
       from public.salvo_skill_settings
       where workspace_id = $1
       order by skill_name asc`,
      [workspaceId]
    );

    return result.rows;
  }

  async upsertSkillSetting(workspaceId: string, skillName: string, enabled: boolean): Promise<DbSkillSetting> {
    const result = await this.pool.query<DbSkillSetting>(
      `insert into public.salvo_skill_settings (
         workspace_id,
         skill_name,
         enabled
       )
       values ($1, $2, $3)
       on conflict (workspace_id, skill_name)
       do update
         set enabled = excluded.enabled,
             updated_at = now()
       returning *`,
      [workspaceId, skillName, enabled]
    );

    return this.singleOrThrow(result.rows, "Failed to upsert skill setting.");
  }

  async listSkillUsage(workspaceId: string, skillNames: string[]): Promise<DbSkillUsage[]> {
    if (skillNames.length === 0) {
      return [];
    }

    const result = await this.pool.query<DbSkillUsage>(
      `select
         payload_json ->> 'tool' as skill_name,
         count(*) filter (where event_type = 'tool.called') as call_count,
         count(*) filter (where event_type = 'tool.result' and (payload_json ->> 'ok') = 'true') as success_count,
         count(*) filter (where event_type = 'tool.result' and (payload_json ->> 'ok') = 'false') as failure_count,
         max(created_at) as last_used_at
       from public.salvo_run_events
       join public.salvo_runs on salvo_run_events.run_id = salvo_runs.id
       join public.salvo_tasks on salvo_runs.task_id = salvo_tasks.id
       where salvo_tasks.workspace_id = $1
         and coalesce(payload_json ->> 'tool', '') = any($2)
       group by skill_name`,
      [workspaceId, skillNames]
    );

    return result.rows.map((row) => ({
      skill_name: row.skill_name,
      call_count: Number(row.call_count ?? 0),
      success_count: Number(row.success_count ?? 0),
      failure_count: Number(row.failure_count ?? 0),
      last_used_at: row.last_used_at ?? null
    }));
  }

  async upsertIntegrationConfig(
    integrationKey: DbIntegrationKey,
    configJson: Record<string, unknown>
  ): Promise<DbIntegrationConfig> {
    const result = await this.pool.query<DbIntegrationConfig>(
      `insert into public.salvo_integration_configs (
         integration_key,
         config_json
       )
       values ($1, $2::jsonb)
       on conflict (integration_key)
       do update
         set config_json = excluded.config_json
       returning *`,
      [integrationKey, JSON.stringify(configJson)]
    );

    return this.singleOrThrow(result.rows, "Failed to upsert integration config.");
  }

  async listResearchContext(
    workspaceId: string,
    limit = 5
  ): Promise<
    {
      id: string;
      source_run_ids: string[];
      confidence: number;
      review_status: "unreviewed" | "accepted" | "rejected";
    }[]
  > {
    const result = await this.pool.query<{
      id: string;
      source_run_ids: string[];
      confidence: number;
      review_status: "unreviewed" | "accepted" | "rejected";
    }>(
      `select id, source_run_ids, confidence, review_status
       from public.salvo_research_documents
       where workspace_id = $1
         and review_status <> 'rejected'
       order by confidence desc, created_at desc
       limit $2`,
      [workspaceId, limit]
    );

    return result.rows;
  }

  async listMemoryContext(
    workspaceId: string,
    limit = 5
  ): Promise<
    {
      id: string;
      confidence: number;
      review_status: "unreviewed" | "accepted" | "rejected";
    }[]
  > {
    const result = await this.pool.query<{
      id: string;
      confidence: number;
      review_status: "unreviewed" | "accepted" | "rejected";
    }>(
      `select id, confidence, review_status
       from public.salvo_memories
       where workspace_id = $1
         and review_status <> 'rejected'
       order by confidence desc, created_at desc
       limit $2`,
      [workspaceId, limit]
    );

    return result.rows;
  }

  async listContractMemoryContext(
    workspaceId: string,
    contractFamilyKey: string,
    limit = 5
  ): Promise<DbContractMemoryContext[]> {
    const result = await this.pool.query<DbContractMemoryContext>(
      `select
         id,
         confidence,
         review_status,
         source_run_ids,
         (
           select replace(tag, 'experiment:', '')
           from unnest(tags) as t(tag)
           where tag like 'experiment:%'
           limit 1
         ) as experiment_id
       from public.salvo_memories
       where workspace_id = $1
         and contract_family_key = $2
         and review_status = 'accepted'
       order by confidence desc, created_at desc
       limit $3`,
      [workspaceId, contractFamilyKey, limit]
    );

    return result.rows;
  }

  async listContractMemoryPromptContext(
    workspaceId: string,
    contractFamilyKey: string,
    limit = 5
  ): Promise<DbContractMemoryPrompt[]> {
    const result = await this.pool.query<DbContractMemoryPrompt>(
      `select
         id,
         title,
         summary,
         body_markdown,
         confidence,
         review_status,
         source_run_ids
       from public.salvo_memories
       where workspace_id = $1
         and contract_family_key = $2
         and review_status = 'accepted'
       order by confidence desc, created_at desc
       limit $3`,
      [workspaceId, contractFamilyKey, limit]
    );

    return result.rows;
  }

  async listResearchDocuments(
    limit = 100,
    reviewStatus?: "unreviewed" | "accepted" | "rejected"
  ): Promise<
    {
      id: string;
      workspace_id: string;
      title: string;
      topic: string;
      confidence: number;
      review_status: "unreviewed" | "accepted" | "rejected";
      source_run_ids: string[];
      created_at: string;
    }[]
  > {
    const params: unknown[] = [limit];
    let sql = `
      select
        id,
        workspace_id,
        title,
        topic,
        confidence,
        review_status,
        source_run_ids,
        created_at
      from public.salvo_research_documents
    `;

    if (reviewStatus) {
      sql += " where review_status = $2";
      params.push(reviewStatus);
    }

    sql += " order by created_at desc limit $1";

    const result = await this.pool.query<{
      id: string;
      workspace_id: string;
      title: string;
      topic: string;
      confidence: number;
      review_status: "unreviewed" | "accepted" | "rejected";
      source_run_ids: string[];
      created_at: string;
    }>(sql, params);

    return result.rows;
  }

  async setResearchReviewStatus(
    researchId: string,
    reviewStatus: "unreviewed" | "accepted" | "rejected"
  ): Promise<void> {
    await this.pool.query(
      `update public.salvo_research_documents
       set review_status = $2
       where id = $1`,
      [researchId, reviewStatus]
    );
  }

  async listResearchExperiments(
    limit = 100,
    reviewStatus?: DbResearchReviewStatus
  ): Promise<
    Array<{
      id: string;
      workspace_id: string;
      contract_family_key: string;
      contract_category: string;
      contract_subcategory: string | null;
      sample_size: number;
      confidence: number;
      review_status: DbResearchReviewStatus;
      source_run_ids: string[];
      published_at: string | null;
      created_at: string;
      metrics_json: Record<string, unknown>;
      body_markdown: string;
    }>
  > {
    const params: unknown[] = [limit];
    let sql = `
      select
        id,
        workspace_id,
        contract_family_key,
        contract_category,
        contract_subcategory,
        sample_size,
        confidence,
        review_status,
        source_run_ids,
        published_at,
        created_at,
        metrics_json,
        body_markdown
      from public.salvo_research_experiments
    `;

    if (reviewStatus) {
      sql += " where review_status = $2";
      params.push(reviewStatus);
    }

    sql += " order by created_at desc limit $1";

    const result = await this.pool.query<{
      id: string;
      workspace_id: string;
      contract_family_key: string;
      contract_category: string;
      contract_subcategory: string | null;
      sample_size: number;
      confidence: number;
      review_status: DbResearchReviewStatus;
      source_run_ids: string[];
      published_at: string | null;
      created_at: string;
      metrics_json: Record<string, unknown>;
      body_markdown: string;
    }>(sql, params);

    return result.rows;
  }

  async setResearchExperimentReviewStatus(
    experimentId: string,
    reviewStatus: DbResearchReviewStatus
  ): Promise<void> {
    await this.pool.query(
      `update public.salvo_research_experiments
       set review_status = $2
       where id = $1`,
      [experimentId, reviewStatus]
    );
  }

  async listMemories(
    limit = 100,
    reviewStatus?: "unreviewed" | "accepted" | "rejected"
  ): Promise<
    {
      id: string;
      workspace_id: string;
      memory_type: string;
      title: string;
      confidence: number;
      review_status: "unreviewed" | "accepted" | "rejected";
      source_run_ids: string[];
      created_at: string;
    }[]
  > {
    const params: unknown[] = [limit];
    let sql = `
      select
        id,
        workspace_id,
        memory_type,
        title,
        confidence,
        review_status,
        source_run_ids,
        created_at
      from public.salvo_memories
    `;

    if (reviewStatus) {
      sql += " where review_status = $2";
      params.push(reviewStatus);
    }

    sql += " order by created_at desc limit $1";

    const result = await this.pool.query<{
      id: string;
      workspace_id: string;
      memory_type: string;
      title: string;
      confidence: number;
      review_status: "unreviewed" | "accepted" | "rejected";
      source_run_ids: string[];
      created_at: string;
    }>(sql, params);

    return result.rows;
  }

  async setMemoryReviewStatus(
    memoryId: string,
    reviewStatus: "unreviewed" | "accepted" | "rejected"
  ): Promise<void> {
    await this.pool.query(
      `update public.salvo_memories
       set review_status = $2
       where id = $1`,
      [memoryId, reviewStatus]
    );
  }
}
