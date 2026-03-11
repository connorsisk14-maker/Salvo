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

  app.post<{ Params: { id: string } }>("/tasks/:id/cancel", async (req, reply) => {
    try {
      const task = await repo.cancelTask(req.params.id);
      return task;
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }
  });

  app.get("/runs", async () => repo.listRuns(200));

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
