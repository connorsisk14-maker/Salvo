import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { buildContractV1 } from "@salvo/contracts";
import { createDbPool, SalvoRepository, type DbRun, type DbRunEvent } from "@salvo/db";
import { evaluateRun } from "@salvo/evaluation";
import { isTerminalRunStatus } from "@salvo/shared";

const workerId = `orchestrator-${randomUUID().slice(0, 8)}`;

class OrchestratorDaemon {
  private readonly repo: SalvoRepository;
  private readonly activeRuns = new Set<string>();
  private claimTimer?: NodeJS.Timeout;
  private staleTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(repo: SalvoRepository) {
    this.repo = repo;
  }

  async start(): Promise<void> {
    await this.repo.ensureWorkspace("default", process.env.SALVO_WORKSPACE_ROOT ?? process.cwd());
    await this.publishHeartbeat();

    this.claimTimer = setInterval(() => {
      void this.claimLoop();
    }, 2_000);

    this.staleTimer = setInterval(() => {
      void this.staleLoop();
    }, 5_000);

    this.heartbeatTimer = setInterval(() => {
      void this.publishHeartbeat();
    }, 5_000);

    await this.claimLoop();
    await this.staleLoop();
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
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    await this.publishHeartbeat({ state: "stopping" });
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

    const [memoryContext, researchContext] = await Promise.all([
      this.repo.listMemoryContext(task.workspace_id, 5),
      this.repo.listResearchContext(task.workspace_id, 5)
    ]);

    const contract = buildContractV1({
      contractId: randomUUID(),
      taskId: task.id,
      workspaceId: task.workspace_id,
      request: task.original_request,
      taskTitle: task.title,
      preferredProfile: "builder"
    });
    contract.context.memory_excerpt_ids = memoryContext.map((entry) => entry.id);
    contract.context.recent_runs = researchContext.flatMap(
      (entry) => entry.source_run_ids
    );

    const contractRecord = await this.repo.createContract({
      taskId: task.id,
      risk: contract.risk,
      status: "active",
      contractJson: contract
    });

    const run = await this.repo.createRun({
      taskId: task.id,
      contractId: contractRecord.id,
      agentProfile: contract.agent_profile,
      workerId
    });

    await this.repo.transitionRunStatus(run.id, "starting", {
      workerId
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

  private async launchRun(run: DbRun): Promise<void> {
    if (this.activeRuns.has(run.id)) {
      return;
    }

    this.activeRuns.add(run.id);

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
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    child.stdout.on("data", (chunk) => {
      process.stdout.write(`[runner:${run.id}] ${chunk}`);
    });

    child.stderr.on("data", (chunk) => {
      process.stderr.write(`[runner:${run.id}] ${chunk}`);
    });

    child.on("error", async (error) => {
      this.activeRuns.delete(run.id);
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
      evidence?: { command_results?: Array<{ exit_code?: number }> };
      learnings?: unknown[];
    };

    const commandResults = payload.evidence?.command_results ?? [];
    const firstExitCode = commandResults.find((item) => item.exit_code !== undefined)?.exit_code;

    const contractJson = detail.contract.contract_json as {
      deliverables?: { required_artifacts?: string[] };
    };

    const evaluation = evaluateRun({
      contractCompliance: 100,
      testsExitCode: firstExitCode,
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

await main();
