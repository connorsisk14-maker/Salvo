import { randomUUID } from "node:crypto";
import { createDbPool, SalvoRepository } from "@salvo/db";

const daemonId = `research-${randomUUID().slice(0, 8)}`;

class ResearchDaemon {
  private readonly repo: SalvoRepository;
  private timer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private processing = false;
  private stopped = false;

  constructor(repo: SalvoRepository) {
    this.repo = repo;
  }

  async start(): Promise<void> {
    await this.publishHeartbeat();

    this.timer = setInterval(() => {
      void this.synthesisLoop();
    }, 15_000);

    this.heartbeatTimer = setInterval(() => {
      void this.publishHeartbeat();
    }, 10_000);

    await this.synthesisLoop();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    await this.publishHeartbeat({ state: "stopping" });
    await this.repo.close();
  }

  private async publishHeartbeat(extra?: Record<string, unknown>): Promise<void> {
    await this.repo.upsertDaemonHeartbeat("research", daemonId, {
      processing: this.processing,
      ...extra
    });
  }

  private async synthesisLoop(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;
    try {
      await this.publishHeartbeat({ processing: true });
      const runs = await this.repo.listUnsynthesizedRuns(10);
      for (const run of runs) {
        const detail = await this.repo.getRunDetail(run.id);
        if (!detail) {
          continue;
        }

        const finalPayload = await this.repo.getRunFinalPayload(run.id);
        const payload = (finalPayload ?? {}) as {
          summary?: string;
          learnings?: Array<{ title?: string; body?: string }>;
          roadblocks?: Array<{ description?: string }>;
        };

        const confidence = Math.max(0, Math.min(1, (detail.run.score ?? 0) / 100));

        const markdown = [
          `# Run Synthesis: ${detail.task.title}`,
          "",
          `- Run ID: ${run.id}`,
          `- Task ID: ${detail.task.id}`,
          `- Status: ${detail.run.status}`,
          `- Score: ${detail.run.score ?? 0}`,
          `- Confidence: ${confidence.toFixed(2)}`,
          "",
          "## Summary",
          payload.summary ?? detail.run.outcome_summary ?? "No summary provided.",
          "",
          "## Learnings",
          ...(payload.learnings && payload.learnings.length > 0
            ? payload.learnings.map(
                (learning) => `- ${learning.title ?? "Learning"}: ${learning.body ?? "(no body)"}`
              )
            : ["- No learnings captured."]),
          "",
          "## Roadblocks",
          ...(payload.roadblocks && payload.roadblocks.length > 0
            ? payload.roadblocks.map((roadblock) => `- ${roadblock.description ?? "(no description)"}`)
            : ["- No roadblocks captured."])
        ].join("\n");

        await this.repo.createResearchDocument({
          workspaceId: detail.task.workspace_id,
          title: `Synthesis for ${detail.task.title}`,
          topic: "run-postmortem",
          bodyMarkdown: markdown,
          sourceRunIds: [run.id],
          confidence,
          reviewStatus: "unreviewed"
        });

        await this.repo.createMemory({
          workspaceId: detail.task.workspace_id,
          sourceRunIds: [run.id],
          memoryType: "best_practice",
          title: `Heuristic from run ${run.id}`,
          summary: payload.summary ?? "Operational synthesis summary",
          bodyMarkdown: markdown,
          tags: ["synthesis", detail.run.status],
          confidence,
          reviewStatus: "unreviewed"
        });

        await this.repo.markRunSynthesized(run.id);
      }
    } finally {
      this.processing = false;
      await this.publishHeartbeat({ processing: false });
    }
  }
}

async function main(): Promise<void> {
  const repo = new SalvoRepository(createDbPool());
  const daemon = new ResearchDaemon(repo);
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
