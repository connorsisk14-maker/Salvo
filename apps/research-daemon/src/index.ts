import { randomUUID } from "node:crypto";
import { createDbPool, ResearchRepository } from "@salvo/db";
import { ResearchAnalysisService } from "./service";

const daemonId = `research-${randomUUID().slice(0, 8)}`;
const synthesisIntervalMs = 15_000;
const heartbeatIntervalMs = 10_000;
const configuredSampleSize = Number(process.env.SALVO_RESEARCH_MIN_SAMPLE_SIZE ?? 15);
const minSampleSize =
  Number.isFinite(configuredSampleSize) && configuredSampleSize >= 1
    ? Math.floor(configuredSampleSize)
    : 15;

class ResearchDaemon {
  private readonly repo: ResearchRepository;
  private readonly service: ResearchAnalysisService;
  private timer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private processing = false;
  private stopped = false;
  private lastCycleStats = {
    ingested: 0,
    experiments: 0,
    published: 0
  };

  constructor(repo: ResearchRepository) {
    this.repo = repo;
    this.service = new ResearchAnalysisService(repo, minSampleSize);
  }

  async start(): Promise<void> {
    await this.publishHeartbeat();

    this.timer = setInterval(() => {
      void this.analysisLoop();
    }, synthesisIntervalMs);

    this.heartbeatTimer = setInterval(() => {
      void this.publishHeartbeat();
    }, heartbeatIntervalMs);

    await this.analysisLoop();
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
    await this.repo.upsertDaemonHeartbeat(daemonId, {
      processing: this.processing,
      min_sample_size: minSampleSize,
      cycle_stats: this.lastCycleStats,
      ...extra
    });
  }

  private async analysisLoop(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;
    try {
      await this.publishHeartbeat({ processing: true });
      this.lastCycleStats = await this.service.runCycle();
    } finally {
      this.processing = false;
      await this.publishHeartbeat({ processing: false });
    }
  }
}

async function main(): Promise<void> {
  const repo = new ResearchRepository(createDbPool());
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
