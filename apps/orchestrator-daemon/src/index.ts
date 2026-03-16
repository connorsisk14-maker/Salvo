import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { buildContractV1 } from "@salvo/contracts";
import { createDbPool, SalvoRepository, type DbRun, type DbRunEvent } from "@salvo/db";
import { evaluateRun } from "@salvo/evaluation";
import { BackupManager, createLogger, isTerminalRunStatus } from "@salvo/shared";

const workerId = `orchestrator-${randomUUID().slice(0, 8)}`;
const logger = createLogger({
  component: "orchestrator-daemon",
  daemon_id: workerId
});

class OrchestratorDaemon {
  private readonly repo: SalvoRepository;
  private readonly backupManager = new BackupManager();
  private readonly activeRuns = new Map<string, ChildProcess>();
  private claimTimer?: NodeJS.Timeout;
  private staleTimer?: NodeJS.Timeout;
  private cancellationTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private backupTimer?: NodeJS.Timeout;
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

    this.cancellationTimer = setInterval(() => {
      void this.cancellationLoop();
    }, 1_500);

    this.heartbeatTimer = setInterval(() => {
      void this.publishHeartbeat();
    }, 5_000);

    this.backupTimer = setInterval(() => {
      void this.backupLoop();
    }, 60_000);

    await this.claimLoop();
    await this.staleLoop();
    await this.cancellationLoop();
    await this.backupLoop();
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
    if (this.cancellationTimer) {
      clearInterval(this.cancellationTimer);
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
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

    const contract = buildContractV1({
      contractId: randomUUID(),
      taskId: task.id,
      workspaceId: task.workspace_id,
      request: task.original_request,
      taskTitle: task.title,
      preferredProfile: "builder"
    });

    const memoryContext = await this.repo.listContractMemoryContext(
      task.workspace_id,
      contract.family_key,
      5
    );
    contract.context.memory_excerpt_ids = memoryContext.map((entry) => entry.id);
    contract.context.recent_runs = [...new Set(memoryContext.flatMap((entry) => entry.source_run_ids))];

    const requiresManualReview = contract.risk === "high" && !task.approved_at;

    const contractRecord = await this.repo.createContract({
      taskId: task.id,
      risk: contract.risk,
      status: requiresManualReview ? "draft" : "active",
      contractJson: contract
    });

    if (requiresManualReview) {
      await this.repo.transitionTaskStatus(task.id, "needs_review");
      logger.warn("task moved to manual review", {
        task_id: task.id,
        contract_id: contractRecord.id,
        risk: contract.risk
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

  private async staleLoop(): Promise<void> {
    const staleRuns = await this.repo.findStaleRuns(30);

    for (const staleRun of staleRuns) {
      if (this.activeRuns.has(staleRun.id)) {
        continue;
      }

      const retry = await this.repo.scheduleRetryFromStaleRun(staleRun.id, workerId, 2);
      logger.warn("stale run detected", {
        run_id: staleRun.id,
        task_id: staleRun.task_id,
        retry_disposition: retry.disposition
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

    child.on("close", async () => {
      this.activeRuns.delete(run.id);
      logger.info("runner process closed", {
        run_id: run.id,
        task_id: run.task_id
      });
      await this.evaluateRun(run.id);
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

    await this.repo.appendRunEvent(runId, evaluation.passed ? "run.completed" : "run.failed", "info", {
      score: evaluation.score,
      outcome: evaluation.outcome
    });
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
