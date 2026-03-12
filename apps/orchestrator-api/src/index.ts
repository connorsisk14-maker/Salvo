import Fastify from "fastify";
import cors from "@fastify/cors";
import { spawn } from "node:child_process";
import { createDbPool, SalvoRepository } from "@salvo/db";

const apiPort = Number(process.env.SALVO_API_PORT ?? 8787);
const orchestratorThresholdSeconds = Number(
  process.env.SALVO_HEALTH_ORCHESTRATOR_STALE_SECONDS ?? 15
);
const researchThresholdSeconds = Number(
  process.env.SALVO_HEALTH_RESEARCH_STALE_SECONDS ?? 45
);

function daemonHealthStatus(heartbeatAt: string, thresholdSeconds: number): "healthy" | "stale" {
  const ageSeconds = (Date.now() - new Date(heartbeatAt).getTime()) / 1000;
  return ageSeconds <= thresholdSeconds ? "healthy" : "stale";
}

type RestartTarget = "orchestrator" | "research";
type ReviewStatus = "unreviewed" | "accepted" | "rejected";

type RestartResult = {
  daemon: RestartTarget;
  killed: boolean;
  started: boolean;
  pid?: number;
  note: string;
};

function runPkill(pattern: string): Promise<{ killed: boolean; note: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pkill", ["-f", pattern], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ killed: true, note: "Existing process terminated." });
        return;
      }

      if (code === 1) {
        resolve({ killed: false, note: "No matching process was running." });
        return;
      }

      reject(new Error(stderr.trim() || `pkill failed with exit code ${code ?? -1}`));
    });

    child.on("error", (error) => {
      reject(error);
    });
  });
}

function startDaemonDetached(target: RestartTarget): { pid?: number } {
  const workspaceRoot = process.env.SALVO_WORKSPACE_ROOT ?? process.cwd();
  const baseEnv = {
    ...process.env,
    SALVO_WORKSPACE_ROOT: workspaceRoot
  };

  const args =
    target === "orchestrator"
      ? ["--filter", "@salvo/orchestrator-daemon", "dev"]
      : ["--filter", "@salvo/research-daemon", "dev"];

  const child = spawn("pnpm", args, {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: baseEnv
  });

  child.unref();
  return { pid: child.pid };
}

async function forceRestartDaemon(target: RestartTarget): Promise<RestartResult> {
  const pattern =
    target === "orchestrator"
      ? "@salvo/orchestrator-daemon dev"
      : "@salvo/research-daemon dev";

  const killResult = await runPkill(pattern);
  const startResult = startDaemonDetached(target);

  return {
    daemon: target,
    killed: killResult.killed,
    started: true,
    pid: startResult.pid,
    note: killResult.note
  };
}

function startSseStream(
  reply: { raw: NodeJS.WritableStream; header: (name: string, value: string) => unknown; hijack: () => void },
  onTick: () => Promise<Record<string, unknown>> | Record<string, unknown>,
  intervalMs: number
): void {
  reply.header("content-type", "text/event-stream");
  reply.header("cache-control", "no-cache");
  reply.header("connection", "keep-alive");
  reply.hijack();

  const writeEvent = async () => {
    const payload = await onTick();
    reply.raw.write(`data: ${JSON.stringify(payload)}\\n\\n`);
  };

  void writeEvent();
  const timer = setInterval(() => {
    void writeEvent();
  }, intervalMs);

  const cleanup = () => {
    clearInterval(timer);
  };

  reply.raw.on?.("close", cleanup);
}

export async function buildServer() {
  const pool = createDbPool();
  const repo = new SalvoRepository(pool);
  await repo.ensureWorkspace("default", process.env.SALVO_WORKSPACE_ROOT ?? process.cwd());

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/health/orchestrator", async () => {
    const heartbeat = await repo.getDaemonHeartbeat("orchestrator");
    if (!heartbeat) {
      return {
        status: "offline",
        threshold_seconds: orchestratorThresholdSeconds
      };
    }

    const ageSeconds = (Date.now() - new Date(heartbeat.heartbeat_at).getTime()) / 1000;
    return {
      status: daemonHealthStatus(heartbeat.heartbeat_at, orchestratorThresholdSeconds),
      daemon_id: heartbeat.daemon_id,
      heartbeat_at: heartbeat.heartbeat_at,
      age_seconds: Number(ageSeconds.toFixed(1)),
      threshold_seconds: orchestratorThresholdSeconds,
      metadata: heartbeat.metadata_json
    };
  });

  app.get("/health/research", async () => {
    const heartbeat = await repo.getDaemonHeartbeat("research");
    if (!heartbeat) {
      return {
        status: "offline",
        threshold_seconds: researchThresholdSeconds
      };
    }

    const ageSeconds = (Date.now() - new Date(heartbeat.heartbeat_at).getTime()) / 1000;
    return {
      status: daemonHealthStatus(heartbeat.heartbeat_at, researchThresholdSeconds),
      daemon_id: heartbeat.daemon_id,
      heartbeat_at: heartbeat.heartbeat_at,
      age_seconds: Number(ageSeconds.toFixed(1)),
      threshold_seconds: researchThresholdSeconds,
      metadata: heartbeat.metadata_json
    };
  });

  app.post<{
    Body: {
      title: string;
      request: string;
      workspaceId?: string;
      requiresApproval?: boolean;
    };
  }>("/tasks", async (req, reply) => {
    const body = req.body;
    if (!body || !body.title || !body.request) {
      return reply.status(400).send({ error: "title and request are required" });
    }

    const task = await repo.createTask({
      title: body.title,
      request: body.request,
      workspaceId: body.workspaceId,
      requiresApproval: body.requiresApproval
    });

    return reply.status(201).send(task);
  });

  app.get("/tasks", async () => {
    return repo.listTasks(200);
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", async (req, reply) => {
    const task = await repo.getTask(req.params.id);
    if (!task) {
      return reply.status(404).send({ error: "Task not found" });
    }
    return task;
  });

  app.post<{ Params: { id: string } }>("/tasks/:id/approve", async (req, reply) => {
    try {
      const task = await repo.approveTask(req.params.id);
      return task;
    } catch (error) {
      return reply.status(404).send({ error: (error as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/tasks/:id/reject", async (req, reply) => {
    try {
      const task = await repo.rejectTask(req.params.id);
      return task;
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/tasks/:id/cancel", async (req, reply) => {
    try {
      const task = await repo.cancelTask(req.params.id);
      return task;
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }
  });

  app.get("/runs", async () => repo.listRunSummaries(200));

  app.post<{ Params: { id: string } }>("/runs/:id/retry", async (req, reply) => {
    try {
      const result = await repo.requestRetryForRun(req.params.id);
      return {
        ok: true,
        source_run_id: result.sourceRun.id,
        task: result.task
      };
    } catch (error) {
      return reply.status(400).send({ ok: false, error: (error as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/runs/:id/cancel", async (req, reply) => {
    try {
      const run = await repo.getRun(req.params.id);
      if (!run) {
        return reply.status(404).send({ ok: false, error: "Run not found" });
      }

      const activeStatuses = ["created", "provisioning", "starting", "running", "evaluating"];
      if (activeStatuses.includes(run.status)) {
        const requested = await repo.requestRunCancellation(req.params.id);
        return {
          ok: true,
          requested: true,
          run: requested
        };
      }

      const result = await repo.cancelRun(req.params.id);
      return {
        ok: true,
        run: result.run,
        task: result.task
      };
    } catch (error) {
      return reply.status(400).send({ ok: false, error: (error as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    const detail = await repo.getRunDetail(req.params.id);
    if (!detail) {
      return reply.status(404).send({ error: "Run not found" });
    }

    const research = await repo.listResearchDocumentsForRun(req.params.id);
    return {
      ...detail,
      research
    };
  });

  app.get<{ Params: { id: string } }>("/runs/:id/events", async (req) => {
    return repo.listRunEvents(req.params.id);
  });

  app.get<{ Params: { id: string } }>("/contracts/:id", async (req, reply) => {
    const contract = await repo.getContract(req.params.id);
    if (!contract) {
      return reply.status(404).send({ error: "Contract not found" });
    }
    return contract;
  });

  app.get<{
    Querystring: { status?: ReviewStatus };
  }>("/research", async (req) => {
    return repo.listResearchDocuments(200, req.query.status);
  });

  app.post<{
    Params: { id: string };
    Body: { status: ReviewStatus };
  }>("/research/:id/review", async (req, reply) => {
    const status = req.body?.status;
    if (!status || !["unreviewed", "accepted", "rejected"].includes(status)) {
      return reply.status(400).send({ error: "Invalid review status." });
    }
    await repo.setResearchReviewStatus(req.params.id, status);
    return { ok: true };
  });

  app.get<{
    Querystring: { status?: ReviewStatus };
  }>("/memories", async (req) => {
    return repo.listMemories(200, req.query.status);
  });

  app.post<{
    Params: { id: string };
    Body: { status: ReviewStatus };
  }>("/memories/:id/review", async (req, reply) => {
    const status = req.body?.status;
    if (!status || !["unreviewed", "accepted", "rejected"].includes(status)) {
      return reply.status(400).send({ error: "Invalid review status." });
    }
    await repo.setMemoryReviewStatus(req.params.id, status);
    return { ok: true };
  });

  app.get("/stream/overview", async (_req, reply) => {
    startSseStream(
      reply,
      async () => {
        const [tasks, runs] = await Promise.all([repo.listTasks(1), repo.listRuns(1)]);
        return {
          ts: new Date().toISOString(),
          last_task: tasks[0]?.updated_at ?? null,
          last_run: runs[0]?.updated_at ?? null
        };
      },
      1500
    );
  });

  app.get<{ Params: { id: string } }>("/stream/runs/:id", async (req, reply) => {
    const runId = req.params.id;
    startSseStream(
      reply,
      async () => {
        const [run, events] = await Promise.all([
          repo.getRun(runId),
          repo.listRunEvents(runId)
        ]);
        return {
          ts: new Date().toISOString(),
          run_status: run?.status ?? null,
          event_count: events.length,
          last_sequence: events.length > 0 ? events[events.length - 1].sequence_no : null
        };
      },
      1000
    );
  });

  app.post<{ Body: { target: RestartTarget | "all" } }>(
    "/control/restart",
    async (req, reply) => {
      const target = req.body?.target;
      if (!target || !["orchestrator", "research", "all"].includes(target)) {
        return reply.status(400).send({
          error: "target must be one of: orchestrator, research, all"
        });
      }

      try {
        if (target === "all") {
          const [orchestrator, research] = await Promise.all([
            forceRestartDaemon("orchestrator"),
            forceRestartDaemon("research")
          ]);
          return {
            ok: true,
            results: [orchestrator, research]
          };
        }

        const result = await forceRestartDaemon(target);
        return {
          ok: true,
          results: [result]
        };
      } catch (error) {
        return reply.status(500).send({
          ok: false,
          error: (error as Error).message
        });
      }
    }
  );

  app.addHook("onClose", async () => {
    await repo.close();
  });

  return app;
}

if (process.argv[1] && process.argv[1].endsWith("index.ts")) {
  const app = await buildServer();
  await app.listen({
    host: "0.0.0.0",
    port: apiPort
  });
}
