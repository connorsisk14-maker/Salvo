import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
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
  DaemonType,
  CreateContractInput,
  CreateMemoryInput,
  CreateResearchInput,
  CreateRunInput,
  CreateTaskInput,
  DbContract,
  DbDaemonHeartbeat,
  DbEvaluation,
  DbRun,
  DbRunSummary,
  DbRunEvent,
  DbTask,
  DbWorkspace,
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

  async createTask(input: CreateTaskInput): Promise<DbTask> {
    const workspaceId =
      input.workspaceId ?? (await this.ensureWorkspace()).id;

    const title = input.title.trim() || "Untitled task";
    const request = input.request.trim();
    const normalized = request.replace(/\s+/g, " ");

    const result = await this.pool.query<DbTask>(
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
         e.findings_json
       from public.salvo_runs r
       left join public.salvo_evaluations e on e.run_id = r.id
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

  async findStaleRuns(staleAfterSeconds = 30): Promise<DbRun[]> {
    const result = await this.pool.query<DbRun>(
      `select *
       from public.salvo_runs
       where status in ('starting', 'running', 'evaluating')
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

  async listUnsynthesizedRuns(limit = 20): Promise<DbRun[]> {
    const result = await this.pool.query<DbRun>(
      `select *
       from public.salvo_runs
       where status in ('completed', 'failed', 'blocked')
         and synthesized_at is null
       order by ended_at asc nulls last, created_at asc
       limit $1`,
      [limit]
    );

    return result.rows;
  }

  async markRunSynthesized(runId: string): Promise<void> {
    await this.pool.query(
      `update public.salvo_runs
       set synthesized_at = now()
       where id = $1`,
      [runId]
    );
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
         memory_type,
         title,
         summary,
         body_markdown,
         tags,
         confidence,
         review_status
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.workspaceId,
        input.sourceRunIds,
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
       from public.salvo_research_documents
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
