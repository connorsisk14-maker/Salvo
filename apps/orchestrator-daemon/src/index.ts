import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { ContractV1 } from "@salvo/contracts";
import { createDbPool, SalvoRepository, type DbRun, type DbRunEvent } from "@salvo/db";
import { evaluateRun } from "@salvo/evaluation";
import {
  BackupManager,
  createLogger,
  estimateRunCost,
  initializeSecrets,
  isTerminalRunStatus,
  resolveLlmProviderAndModel
} from "@salvo/shared";
import {
  buildHeuristicContract,
  collectWorkspaceSnapshot,
  planContract,
  resolveContractPlannerConfig
} from "./contract-planner";
import {
  resolvePlannerHour,
  runEveningPlannerCycle,
  shouldRunEveningPlanner,
  toLocalDateKey
} from "./planner";
import { applyTrustTierPolicy } from "./trust-tier";

await initializeSecrets();

const workerId = `orchestrator-${randomUUID().slice(0, 8)}`;
const staleRunThresholdSeconds = readPositiveIntegerEnv(
  "SALVO_RECOVERY_ORPHAN_RUN_AFTER_SECONDS",
  30
);
const orphanTaskThresholdSeconds = readPositiveIntegerEnv(
  "SALVO_RECOVERY_ORPHAN_TASK_AFTER_SECONDS",
  120
);
const recoveryMaxAttempts = readPositiveIntegerEnv("SALVO_RECOVERY_MAX_RUN_ATTEMPTS", 2);
const logger = createLogger({
  component: "orchestrator-daemon",
  daemon_id: workerId
});

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

class OrchestratorDaemon {
  private readonly repo: SalvoRepository;
  private readonly backupManager = new BackupManager();
  private readonly activeRuns = new Map<string, ChildProcess>();
  private claimTimer?: NodeJS.Timeout;
  private staleTimer?: NodeJS.Timeout;
  private recoveryTimer?: NodeJS.Timeout;
  private cancellationTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private backupTimer?: NodeJS.Timeout;
  private plannerTimer?: NodeJS.Timeout;
  private plannerInFlight = false;
  private lastPlannerDateKey?: string;
  private readonly plannerHour = resolvePlannerHour(process.env.SALVO_PLANNER_HOUR);
  private readonly plannerMaxDraftsPerWorkspace = readPositiveIntegerEnv(
    "SALVO_PLANNER_MAX_DRAFTS_PER_WORKSPACE",
    3
  );
  private stopped = false;

  constructor(repo: SalvoRepository) {
    this.repo = repo;
  }

  async start(): Promise<void> {
    await this.repo.ensureWorkspace("default", process.env.SALVO_WORKSPACE_ROOT ?? process.cwd());
    await this.publishHeartbeat();
    logger.info("daemon started", {
      workspace_root: process.env.SALVO_WORKSPACE_ROOT ?? process.cwd()
    });

    this.claimTimer = setInterval(() => {
      void this.claimLoop();
    }, 2_000);

    this.staleTimer = setInterval(() => {
      void this.staleLoop();
    }, 5_000);

    this.recoveryTimer = setInterval(() => {
      void this.recoverOrphanedTasksLoop();
    }, 15_000);

    this.cancellationTimer = setInterval(() => {
      void this.cancellationLoop();
    }, 1_500);

    this.heartbeatTimer = setInterval(() => {
      void this.publishHeartbeat();
    }, 5_000);

    this.backupTimer = setInterval(() => {
      void this.backupLoop();
    }, 60_000);

    this.plannerTimer = setInterval(() => {
      void this.plannerLoop();
    }, 60_000);

    await this.claimLoop();
    await this.staleLoop();
    await this.recoverOrphanedTasksLoop();
    await this.cancellationLoop();
    await this.backupLoop();
    await this.plannerLoop();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    if (this.claimTimer) {
      clearInterval(this.claimTimer);
    }
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
    }
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
    }
    if (this.cancellationTimer) {
      clearInterval(this.cancellationTimer);
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
    }
    if (this.plannerTimer) {
      clearInterval(this.plannerTimer);
    }
    await this.publishHeartbeat({ state: "stopping" });
    logger.info("daemon stopping", {
      active_runs: this.activeRuns.size
    });
    await this.repo.close();
  }

  private async publishHeartbeat(extra?: Record<string, unknown>): Promise<void> {
    await this.repo.upsertDaemonHeartbeat("orchestrator", workerId, {
      active_runs: this.activeRuns.size,
      ...extra
    });
  }

  private async claimLoop(): Promise<void> {
    const task = await this.repo.claimNextTask(workerId);
    if (!task) {
      return;
    }
    logger.info("task claimed", {
      task_id: task.id,
      workspace_id: task.workspace_id
    });

    const heuristicContract = buildHeuristicContract({
      contractId: randomUUID(),
      taskId: task.id,
      workspaceId: task.workspace_id,
      request: task.original_request,
      taskTitle: task.title,
      preferredProfile: task.preferred_agent_profile ?? undefined
    });
    const [workspace, memoryContext, researchContext, integrationConfigs] = await Promise.all([
      this.repo.getWorkspace(task.workspace_id),
      this.repo.listContractMemoryPromptContext(
        task.workspace_id,
        heuristicContract.family_key,
        5
      ),
      this.repo.listResearchContext(task.workspace_id, 5),
      this.repo.listIntegrationConfigs()
    ]);
    const workspaceContext = workspace ?? {
      id: task.workspace_id,
      name: "default",
      local_path: process.env.SALVO_WORKSPACE_ROOT ?? process.cwd()
    };
    const workspaceEntries = await collectWorkspaceSnapshot(workspaceContext.local_path);
    const plannedContract = await planContract({
      task,
      workspace: workspaceContext,
      baseContract: heuristicContract,
      workspaceEntries,
      memories: memoryContext,
      recentRunHistory: [
        ...new Set([
          ...memoryContext.flatMap((entry) => entry.source_run_ids),
          ...researchContext.flatMap((entry) => entry.source_run_ids)
        ])
      ].map((runId) => ({ runId })),
      activeResearchFindings: researchContext.map((entry) => ({
        id: entry.id,
        confidence: entry.confidence
      })),
      llmConfig: resolveContractPlannerConfig({
        integrationConfigs,
        env: process.env
      })
    });
    const trustTierState = await this.repo.getAgentTrustTier(
      task.workspace_id,
      plannedContract.contract.agent_profile
    );
    const governedContract = applyTrustTierPolicy(
      plannedContract.contract,
      trustTierState.trust_tier
    );
    const contract = governedContract.contract;

    const memoryReferenceContext = await this.repo.listContractMemoryContext(
      task.workspace_id,
      contract.family_key,
      5
    );
    contract.context.memory_excerpt_ids = [
      ...new Set(memoryReferenceContext.map((entry) => entry.id))
    ];
    contract.context.recent_runs = [
      ...new Set(memoryReferenceContext.flatMap((entry) => entry.source_run_ids))
    ];

    if (plannedContract.source === "fallback") {
      await this.repo.createAuditEvent({
        actor: `system:${workerId}`,
        action: "contract.llm_fallback",
        target: task.id,
        metadata: {
          workspace_id: task.workspace_id,
          contract_family_key: heuristicContract.family_key,
          reason: plannedContract.reason ?? "unknown"
        }
      });
    }
    logger.info("contract planned", {
      task_id: task.id,
      workspace_id: task.workspace_id,
      contract_source: plannedContract.source,
      family_key: contract.family_key,
      risk: contract.risk,
      agent_profile: contract.agent_profile,
      trust_tier: trustTierState.trust_tier
    });

    const requiresRiskReview = contract.risk === "high" && !task.approved_at;
    const requiresTierReview = governedContract.requiresManualReview && !task.approved_at;
    const requiresManualReview = requiresRiskReview || requiresTierReview;
    const budgetCheck = await this.checkBudgetCap(task, contract);
    const requiresBudgetReview = budgetCheck.blockingBudgets.length > 0;

    const contractRecord = await this.repo.createContract({
      taskId: task.id,
      risk: contract.risk,
      status: requiresManualReview || requiresBudgetReview ? "draft" : "active",
      contractJson: contract
    });

    if (requiresManualReview || requiresBudgetReview) {
      await this.repo.transitionTaskStatus(task.id, "needs_review");
      if (requiresBudgetReview) {
        await this.repo.createAuditEvent({
          actor: `system:${workerId}`,
          action: "budget.blocked",
          target: task.id,
          metadata: {
            contract_id: contractRecord.id,
            workspace_id: task.workspace_id,
            contract_family_key: contract.family_key,
            trust_tier: trustTierState.trust_tier,
            provider: budgetCheck.provider,
            model: budgetCheck.model,
            estimated_cost_usd: budgetCheck.estimate.cost_usd,
            estimated_input_tokens: budgetCheck.estimate.input_tokens,
            estimated_output_tokens: budgetCheck.estimate.output_tokens,
            heuristic: budgetCheck.estimate.heuristic,
            budgets: budgetCheck.blockingBudgets.map((entry) => ({
              scope: entry.scope,
              contract_family_key: entry.contract_family_key,
              limit_usd: entry.limit_usd,
              spent_usd: entry.spent_usd,
              remaining_usd: entry.remaining_usd
            }))
          }
        });
      }

      logger.warn("task moved to manual review", {
        task_id: task.id,
        contract_id: contractRecord.id,
        risk: contract.risk,
        trust_tier: trustTierState.trust_tier,
        review_reasons: [
          ...(requiresRiskReview ? ["risk"] : []),
          ...(requiresTierReview ? ["trust_tier"] : []),
          ...(requiresBudgetReview ? ["budget"] : [])
        ],
        estimated_cost_usd: budgetCheck.estimate.cost_usd,
        blocking_budget_scopes: budgetCheck.blockingBudgets.map((entry) => entry.scope)
      });
      return;
    }

    const run = await this.repo.createRun({
      taskId: task.id,
      contractId: contractRecord.id,
      agentProfile: contract.agent_profile,
      workerId
    });

    await this.repo.transitionRunStatus(run.id, "starting", {
      workerId
    });
    logger.info("run created", {
      run_id: run.id,
      task_id: run.task_id,
      contract_id: run.contract_id
    });

    await this.launchRun(run);
  }

  private async checkBudgetCap(
    task: {
      id: string;
      workspace_id: string;
      title: string;
      original_request: string;
    },
    contract: ContractV1
  ): Promise<{
    provider: string;
    model: string;
    estimate: ReturnType<typeof estimateRunCost>;
    blockingBudgets: Awaited<ReturnType<SalvoRepository["listApplicableBudgetStatuses"]>>;
  }> {
    const integrationConfigs = await this.repo.listIntegrationConfigs();
    const llmConfig =
      integrationConfigs.find((row) => row.integration_key === "llm_api")?.config_json ?? {};
    const routing = resolveLlmProviderAndModel({
      llmConfig,
      env: process.env,
      agentProfile: contract.agent_profile
    });
    const estimate = estimateRunCost({
      model: routing.model,
      agentProfile: contract.agent_profile,
      title: task.title,
      request: task.original_request,
      contractJson: contract,
      relevantFileCount: contract.context.relevant_files.length,
      recentRunCount: contract.context.recent_runs.length,
      memoryExcerptCount: contract.context.memory_excerpt_ids.length
    });
    const budgets = await this.repo.listApplicableBudgetStatuses(
      task.workspace_id,
      contract.family_key
    );

    return {
      provider: routing.provider,
      model: routing.model,
      estimate,
      blockingBudgets: budgets.filter(
        (entry) => estimate.cost_usd > 0 && estimate.cost_usd > entry.remaining_usd
      )
    };
  }

  private async staleLoop(): Promise<void> {
    const staleRuns = await this.repo.findStaleRuns(staleRunThresholdSeconds);

    for (const staleRun of staleRuns) {
      if (this.activeRuns.has(staleRun.id)) {
        continue;
      }

      const retry = await this.repo.scheduleRetryFromStaleRun(
        staleRun.id,
        workerId,
        recoveryMaxAttempts
      );
      logger.warn("stale run detected", {
        run_id: staleRun.id,
        task_id: staleRun.task_id,
        retry_disposition: retry.disposition
      });
      await this.repo.createAuditEvent({
        actor: `system:${workerId}`,
        action: "recovery.run_marked_stale",
        target: staleRun.id,
        metadata: {
          task_id: staleRun.task_id,
          stale_after_seconds: staleRunThresholdSeconds,
          retry_disposition: retry.disposition,
          attempt_no: staleRun.attempt_no,
          status: staleRun.status
        }
      });
      await this.repo.appendRunEvent(staleRun.id, "run.failed", "error", {
        reason: "stale_runner",
        retry_disposition: retry.disposition
      });

      if (retry.disposition === "scheduled" && retry.retryRun) {
        await this.repo.appendRunEvent(retry.retryRun.id, "run.started", "info", {
          reason: "retry_from_stale_run",
          source_run_id: staleRun.id
        });
        await this.repo.transitionRunStatus(retry.retryRun.id, "starting", { workerId });
        await this.launchRun(retry.retryRun);
      }
    }
  }

  private async recoverOrphanedTasksLoop(): Promise<void> {
    const tasks = await this.repo.findOrphanedTasks(orphanTaskThresholdSeconds, 20);

    for (const task of tasks) {
      const recovered = await this.repo.recoverOrphanedTask(task.id);
      if (recovered.status !== "queued") {
        continue;
      }

      logger.warn("orphaned task re-queued", {
        task_id: recovered.id,
        workspace_id: recovered.workspace_id,
        claimed_by: task.claimed_by
      });
      await this.repo.createAuditEvent({
        actor: `system:${workerId}`,
        action: "recovery.orphan_task_requeued",
        target: recovered.id,
        metadata: {
          workspace_id: recovered.workspace_id,
          orphan_after_seconds: orphanTaskThresholdSeconds,
          prior_claimed_by: task.claimed_by
        }
      });
    }
  }

  private async cancellationLoop(): Promise<void> {
    const runs = await this.repo.listCancellationRequestedRuns(20);
    for (const run of runs) {
      await this.forceCancelRun(run);
    }
  }

  private async backupLoop(): Promise<void> {
    try {
      const result = await this.backupManager.runScheduledBackupIfDue();
      if (!result) {
        return;
      }

      logger.info("scheduled backup completed", {
        started_at: result.started_at,
        completed_at: result.completed_at,
        backup_path: result.backup?.path ?? null,
        backup_size_bytes: result.backup?.size_bytes ?? null
      });
    } catch (error) {
      logger.error("scheduled backup failed", {
        error
      });
    }
  }

  private async plannerLoop(): Promise<void> {
    if (this.plannerInFlight) {
      return;
    }

    const now = new Date();
    if (
      !shouldRunEveningPlanner({
        now,
        plannerHour: this.plannerHour,
        lastPlannedDateKey: this.lastPlannerDateKey
      })
    ) {
      return;
    }

    this.plannerInFlight = true;
    try {
      const result = await runEveningPlannerCycle({
        repo: this.repo,
        workerId,
        now,
        plannerHour: this.plannerHour,
        env: process.env,
        maxDraftsPerWorkspace: this.plannerMaxDraftsPerWorkspace
      });
      this.lastPlannerDateKey = result.dateKey;
      logger.info("evening planner cycle completed", {
        planning_date: result.dateKey,
        target_date: result.targetDateKey,
        planner_hour: this.plannerHour,
        workspace_count: result.workspaceCount,
        created_draft_count: result.createdDraftCount,
        skipped_duplicate_count: result.skippedDuplicateCount
      });
    } catch (error) {
      const planningDate = toLocalDateKey(now);
      logger.error("evening planner cycle failed", {
        planning_date: planningDate,
        planner_hour: this.plannerHour,
        error
      });
      try {
        await this.repo.createAuditEvent({
          actor: `system:${workerId}`,
          action: "planning.failed",
          metadata: {
            planning_date: planningDate,
            planner_hour: this.plannerHour,
            error: error instanceof Error ? error.message : String(error)
          }
        });
      } catch (auditError) {
        logger.error("planning failure audit emission failed", {
          planning_date: planningDate,
          planner_hour: this.plannerHour,
          error: auditError
        });
      }
    } finally {
      this.plannerInFlight = false;
    }
  }

  private async forceCancelRun(run: DbRun): Promise<void> {
    logger.warn("cancellation requested run cleanup", {
      run_id: run.id,
      task_id: run.task_id,
      runner_pid: run.runner_pid
    });
    const child = this.activeRuns.get(run.id);
    if (child && !child.killed) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 3_000);
    } else if (run.runner_pid) {
      try {
        process.kill(run.runner_pid, "SIGTERM");
      } catch {
        // process may already be gone
      }
    }

    try {
      await this.repo.cancelRun(run.id);
    } catch {
      // run may have already reached terminal state concurrently
    }
  }

  private async launchRun(run: DbRun): Promise<void> {
    if (this.activeRuns.has(run.id)) {
      return;
    }

    const child = spawn(
      "pnpm",
      ["--filter", "@salvo/agent-runner", "runner", "--", "--run-id", run.id],
      {
        env: {
          ...process.env,
          SALVO_DATABASE_URL: process.env.SALVO_DATABASE_URL,
          SALVO_WORKSPACE_ROOT:
            process.env.SALVO_WORKSPACE_ROOT ?? process.cwd()
        },
        stdio: ["ignore", "inherit", "inherit"]
      }
    );
    this.activeRuns.set(run.id, child);
    logger.info("runner spawned", {
      run_id: run.id,
      task_id: run.task_id,
      child_pid: child.pid
    });

    child.on("error", async (error) => {
      this.activeRuns.delete(run.id);
      logger.error("runner process error", {
        run_id: run.id,
        task_id: run.task_id,
        error
      });
      await this.repo.appendRunEvent(run.id, "run.failed", "error", {
        reason: "runner_spawn_error",
        error: error.message
      });
      const current = await this.repo.getRun(run.id);
      if (current && !isTerminalRunStatus(current.status)) {
        await this.repo.transitionRunStatus(run.id, "failed", {
          exitReason: "runner_crash",
          outcomeSummary: `Runner spawn failed: ${error.message}`,
          endedAt: new Date()
        });
      }
      await this.repo.transitionTaskStatus(run.task_id, "failed");
    });

    child.on("close", async (code, signal) => {
      this.activeRuns.delete(run.id);
      logger.info("runner process closed", {
        run_id: run.id,
        task_id: run.task_id,
        exit_code: code,
        signal
      });

      try {
        const current = await this.repo.getRun(run.id);
        if (!current || isTerminalRunStatus(current.status)) {
          return;
        }

        if (current.status === "starting") {
          const reasonParts = [];
          if (typeof code === "number") {
            reasonParts.push(`exit code ${code}`);
          }
          if (signal) {
            reasonParts.push(`signal ${signal}`);
          }
          const reason = reasonParts.length > 0 ? reasonParts.join(", ") : "runner exited before startup";

          await this.repo.appendRunEvent(run.id, "run.failed", "error", {
            reason: "runner_startup_failure",
            exit_code: code,
            signal: signal ?? null
          });
          await this.repo.transitionRunStatus(run.id, "failed", {
            exitReason: "runner_crash",
            outcomeSummary: `Runner exited before startup: ${reason}`,
            endedAt: new Date()
          });
          await this.repo.transitionTaskStatus(run.task_id, "failed");
          return;
        }

        await this.evaluateRun(run.id);
      } catch (error) {
        logger.error("runner close handling failed", {
          run_id: run.id,
          task_id: run.task_id,
          exit_code: code,
          signal,
          error
        });
      }
    });
  }

  private findPolicyDeniedCount(events: DbRunEvent[]): number {
    return events.filter((event) => event.event_type === "policy.denied").length;
  }

  private async evaluateRun(runId: string): Promise<void> {
    const detail = await this.repo.getRunDetail(runId);
    if (!detail) {
      return;
    }

    if (isTerminalRunStatus(detail.run.status)) {
      return;
    }

    await this.repo.transitionRunStatus(runId, "evaluating");

    const finalPayload = await this.repo.getRunFinalPayload(runId);
    const events = await this.repo.listRunEvents(runId);
    const policyDeniedCount = this.findPolicyDeniedCount(events);

    const payload = (finalPayload ?? {}) as {
      deliverables?: string[];
      evidence?: {
        command_results?: Array<{ exit_code?: number }>;
        tests_run?: Array<{ command?: string; exit_code?: number; denied?: boolean }>;
      };
      learnings?: unknown[];
    };

    const commandResults = payload.evidence?.command_results ?? [];
    const firstExitCode = commandResults.find((item) => item.exit_code !== undefined)?.exit_code;

    const contractJson = detail.contract.contract_json as {
      deliverables?: { required_artifacts?: string[] };
      success_criteria?: {
        required_test_commands?: string[];
        assertions?: string[];
      };
    };

    const evaluation = evaluateRun({
      contractCompliance: 100,
      testsExitCode: firstExitCode,
      testsRun: payload.evidence?.tests_run ?? [],
      requiredTestCommands: contractJson.success_criteria?.required_test_commands ?? [],
      requiredAssertions: contractJson.success_criteria?.assertions ?? [],
      finalPayloadPresent: finalPayload !== null,
      requiredDeliverables: contractJson.deliverables?.required_artifacts ?? ["run-summary.md"],
      producedDeliverables: payload.deliverables ?? [],
      evidencePresent: payload.evidence !== undefined,
      learningsCount: payload.learnings?.length ?? 0,
      policyDeniedCount
    });

    await this.repo.recordEvaluation({
      runId,
      contractId: detail.contract.id,
      passed: evaluation.passed,
      score: evaluation.score,
      outcome: evaluation.outcome,
      hardFailReason: evaluation.hardFailReason,
      findings: evaluation.findings
    });

    await this.repo.appendRunEvent(runId, "evaluation.completed", "info", {
      passed: evaluation.passed,
      score: evaluation.score,
      outcome: evaluation.outcome,
      findings: evaluation.findings,
      hard_fail_reason: evaluation.hardFailReason ?? null
    });

    const runStatus = evaluation.passed ? "completed" : "failed";
    await this.repo.transitionRunStatus(runId, runStatus, {
      score: evaluation.score,
      exitReason: evaluation.passed ? "success" : "evaluation_failed",
      outcomeSummary: evaluation.passed
        ? "Run passed deterministic evaluation."
        : `Run failed deterministic evaluation: ${evaluation.hardFailReason ?? "score below threshold"}`,
      endedAt: new Date(),
      heartbeatAt: new Date()
    });

    await this.repo.transitionTaskStatus(detail.task.id, evaluation.passed ? "completed" : "failed");
    const trustTierOutcome = await this.repo.recordAgentTrustTierOutcome(
      detail.task.workspace_id,
      detail.run.agent_profile,
      evaluation.passed
    );

    if (trustTierOutcome.promoted) {
      await this.repo.createAuditEvent({
        actor: `system:${workerId}`,
        action: "trust_tier.promoted",
        target: detail.task.id,
        metadata: {
          workspace_id: detail.task.workspace_id,
          agent_profile: detail.run.agent_profile,
          from: trustTierOutcome.before.trust_tier,
          to: trustTierOutcome.after.trust_tier,
          successful_runs: trustTierOutcome.after.successful_runs,
          run_id: runId
        }
      });
      logger.info("agent trust tier promoted", {
        run_id: runId,
        workspace_id: detail.task.workspace_id,
        agent_profile: detail.run.agent_profile,
        from: trustTierOutcome.before.trust_tier,
        to: trustTierOutcome.after.trust_tier
      });
    }

    await this.repo.appendRunEvent(runId, evaluation.passed ? "run.completed" : "run.failed", "info", {
      score: evaluation.score,
      outcome: evaluation.outcome
    });

    await this.handleLeadRunChain(detail, finalPayload, runId, evaluation.passed);
  }

  private async handleLeadRunChain(
    detail: Awaited<ReturnType<SalvoRepository["getRunDetail"]>>,
    finalPayload: Record<string, unknown> | null,
    runId: string,
    evaluationPassed: boolean
  ): Promise<void> {
    if (!detail) {
      return;
    }

    if (detail.run.agent_profile === "lead_scraper" && evaluationPassed) {
      await this.createLeadStrategistTask(detail, finalPayload);
      return;
    }

    if (detail.run.agent_profile === "lead_strategist") {
      await this.linkLeadStrategistRun(detail.task.id, runId);
    }
  }

  private async createLeadStrategistTask(
    detail: Awaited<ReturnType<SalvoRepository["getRunDetail"]>>,
    finalPayload: Record<string, unknown> | null
  ): Promise<void> {
    if (!detail) {
      return;
    }

    const existing = await this.repo.findLeadRunChainByScraperRun(detail.run.id);
    if (existing) {
      return;
    }

    const rowContext = this.extractLeadRowContext(finalPayload);
    const request = this.buildLeadStrategistRequest(detail, rowContext);
    const strategistTask = await this.repo.createTask({
      workspaceId: detail.task.workspace_id,
      title: `Lead strategist follow-up (${detail.run.id.slice(0, 8)})`,
      request,
      requiresApproval: false,
      preferredAgentProfile: "lead_strategist"
    });
    await this.repo.createLeadRunChain({
      scraperRunId: detail.run.id,
      strategistTaskId: strategistTask.id,
      rowContext
    });
    const rowSummaryLabel = this.formatLeadRowContextSummary(rowContext);
    logger.info("lead strategist follow-up created", {
      scraper_run_id: detail.run.id,
      strategist_task_id: strategistTask.id,
      row_summary: rowSummaryLabel
    });
  }

  private async linkLeadStrategistRun(taskId: string, runId: string): Promise<void> {
    const chain = await this.repo.findLeadRunChainByStrategistTask(taskId);
    if (!chain || chain.strategist_run_id) {
      return;
    }
    await this.repo.linkLeadRunChainStrategistRun(chain.id, runId);
    logger.info("lead strategist run linked to chain", {
      strategist_task_id: taskId,
      strategist_run_id: runId,
      chain_id: chain.id
    });
  }

  private buildLeadStrategistRequest(
    detail: Awaited<ReturnType<SalvoRepository["getRunDetail"]>>,
    rowContext: Record<string, unknown> | null
  ): string {
    if (!detail) {
      return "Lead strategist follow-up.";
    }

    const summary = this.formatLeadRowContextSummary(rowContext);
    const snippet = this.stringifyLeadRowContext(rowContext);
    const familyKey =
      typeof detail.contract.contract_json.family_key === "string"
        ? detail.contract.contract_json.family_key
        : detail.contract.id;
    const taskTitle = detail.task.title;
    const sheetId = process.env.SALVO_LEAD_PIPELINE_SHEET_ID?.trim();
    const sheetNote = sheetId
      ? `Reference Google Sheet ${sheetId} for redistribution updates.`
      : "Capture follow-up notes in the primary lead tracking destination.";
    return [
      `Lead Strategist follow-up for \"${taskTitle}\" (run ${detail.run.id}, family ${familyKey}).`,
      `Row summary: ${summary}`,
      `Detailed row snapshot (truncated):\n${snippet}`,
      sheetNote,
      `Original scraper request: ${detail.task.original_request}`
    ].join("\n\n");
  }

  private extractLeadRowContext(payload: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!payload) {
      return null;
    }

    const candidateKeys = [
      "row_context",
      "row",
      "lead",
      "lead_row",
      "lead_data",
      "row_data",
      "leadContext"
    ];

    for (const key of candidateKeys) {
      const value = payload[key];
      if (this.isPlainRecord(value)) {
        return value;
      }
      if (Array.isArray(value)) {
        const recordItem = value.find((item) => this.isPlainRecord(item));
        if (recordItem) {
          return recordItem as Record<string, unknown>;
        }
      }
    }

    if (typeof payload.summary === "string" && payload.summary.trim().length > 0) {
      return { summary: payload.summary };
    }

    const deliverables = payload.deliverables;
    if (Array.isArray(deliverables) && deliverables.length > 0) {
      return { deliverables: deliverables.slice(0, 3) };
    }

    return null;
  }

  private formatLeadRowContextSummary(rowContext: Record<string, unknown> | null): string {
    if (!rowContext) {
      return "Row context not captured.";
    }
    const entries = Object.entries(rowContext);
    if (entries.length === 0) {
      return "Row context captured but empty.";
    }
    const summary = entries
      .slice(0, 3)
      .map(([key, value]) => `${key}: ${this.describeLeadRowValue(value)}`)
      .join(" · ");
    if (entries.length > 3) {
      return `${summary} · +${entries.length - 3} more`;
    }
    return summary;
  }

  private stringifyLeadRowContext(rowContext: Record<string, unknown> | null, limit = 1200): string {
    if (!rowContext) {
      return "Row context not available.";
    }
    const json = JSON.stringify(rowContext, null, 2);
    return json.length <= limit ? json : `${json.slice(0, limit)}…`;
  }

  private describeLeadRowValue(value: unknown): string {
    if (typeof value === "string") {
      return value.length <= 60 ? value : `${value.slice(0, 57)}…`;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (Array.isArray(value)) {
      return `[${value.length} items]`;
    }
    if (value === null || value === undefined) {
      return "—";
    }
    return "{…}";
  }

  private isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

async function main(): Promise<void> {
  const repo = new SalvoRepository(createDbPool());
  const daemon = new OrchestratorDaemon(repo);

  await daemon.start();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await daemon.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });

  process.once("SIGTERM", () => {
    void shutdown();
  });
}

try {
  await main();
} catch (error) {
  logger.error("daemon crashed", { error });
  process.exit(1);
}
