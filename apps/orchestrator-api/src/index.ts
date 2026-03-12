import Fastify from "fastify";
import cors from "@fastify/cors";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
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
type IntegrationStatus =
  | "ready"
  | "not_configured"
  | "needs_auth"
  | "error"
  | "healthy"
  | "stale"
  | "offline";
type EditableIntegrationKey = "supabase" | "llm_api" | "process" | "http";
type LlmProvider = "anthropic" | "openai" | "custom";

type IntegrationConfigMap = {
  supabase: {
    url: string;
    anonKey: string;
  };
  llm_api: {
    provider: LlmProvider;
    apiKey: string;
    baseUrl: string;
    defaultModel: string;
  };
  process: {
    command: string;
  };
  http: {
    baseUrl: string;
    token: string;
  };
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".log",
  ".yaml",
  ".yml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".css",
  ".html"
]);
const MAX_TEXT_PREVIEW_BYTES = 64_000;

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

function contentTypeForArtifact(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md" || ext === ".txt" || ext === ".log") {
    return "text/plain; charset=utf-8";
  }
  if (ext === ".json") {
    return "application/json; charset=utf-8";
  }
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (ext === ".svg") {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

function isPreviewableText(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isPreviewableImage(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function hasValue(input: string | undefined): boolean {
  return Boolean(input && input.trim().length > 0);
}

function isValidHttpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeProvider(input: string | undefined): LlmProvider {
  if (input === "openai" || input === "custom" || input === "anthropic") {
    return input;
  }
  return "anthropic";
}

function readString(
  config: Record<string, unknown>,
  key: string,
  fallback = ""
): string {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
}

function createDefaultConfigMap(): IntegrationConfigMap {
  return {
    supabase: {
      url: process.env.SALVO_SUPABASE_URL ?? "",
      anonKey: process.env.SALVO_SUPABASE_ANON_KEY ?? ""
    },
    llm_api: {
      provider: normalizeProvider(process.env.SALVO_LLM_PROVIDER),
      apiKey: process.env.SALVO_LLM_API_KEY ?? process.env.SALVO_CLAUDE_AUTH_TOKEN ?? "",
      baseUrl: process.env.SALVO_LLM_BASE_URL ?? "",
      defaultModel: process.env.SALVO_LLM_DEFAULT_MODEL ?? ""
    },
    process: {
      command:
        process.env.SALVO_PROCESS_COMMAND ??
        "pnpm --filter @salvo/agent-runner runner -- --run-id <id>"
    },
    http: {
      baseUrl: process.env.SALVO_HTTP_BASE_URL ?? "",
      token: process.env.SALVO_HTTP_TOKEN ?? ""
    }
  };
}

function applyStoredConfig(
  defaults: IntegrationConfigMap,
  rows: Array<{ integration_key: string; config_json: Record<string, unknown> }>
): IntegrationConfigMap {
  const next = structuredClone(defaults);
  for (const row of rows) {
    const config = row.config_json ?? {};
    if (row.integration_key === "supabase") {
      next.supabase.url = readString(config, "url", next.supabase.url);
      next.supabase.anonKey = readString(config, "anonKey", next.supabase.anonKey);
      continue;
    }

    if (row.integration_key === "llm_api" || row.integration_key === "claude_local") {
      next.llm_api.provider = normalizeProvider(
        readString(config, "provider", next.llm_api.provider)
      );
      next.llm_api.apiKey = readString(
        config,
        "apiKey",
        readString(config, "authToken", next.llm_api.apiKey)
      );
      next.llm_api.baseUrl = readString(config, "baseUrl", next.llm_api.baseUrl);
      next.llm_api.defaultModel = readString(
        config,
        "defaultModel",
        next.llm_api.defaultModel
      );
      continue;
    }

    if (row.integration_key === "process") {
      next.process.command = readString(config, "command", next.process.command);
      continue;
    }

    if (row.integration_key === "http") {
      next.http.baseUrl = readString(config, "baseUrl", next.http.baseUrl);
      next.http.token = readString(config, "token", next.http.token);
    }
  }

  return next;
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

  app.get("/integrations", async () => {
    const [orchestratorHeartbeat, researchHeartbeat, configs] = await Promise.all([
      repo.getDaemonHeartbeat("orchestrator"),
      repo.getDaemonHeartbeat("research"),
      repo.listIntegrationConfigs()
    ]);

    const now = new Date().toISOString();
    const defaultConfig = createDefaultConfigMap();
    const config = applyStoredConfig(defaultConfig, configs);
    const configUpdatedByKey = new Map<string, string>(
      configs.map((item) => [item.integration_key, item.updated_at])
    );

    return [
      {
        key: "supabase",
        label: "Supabase",
        status: hasValue(config.supabase.url) && hasValue(config.supabase.anonKey) ? "ready" : "not_configured",
        detail: hasValue(config.supabase.url) && hasValue(config.supabase.anonKey)
          ? "Supabase URL and anon key configured."
          : "Set Supabase URL and anon key.",
        updated_at: configUpdatedByKey.get("supabase") ?? now,
        editable: true,
        config: {
          url: config.supabase.url,
          anon_key_configured: hasValue(config.supabase.anonKey)
        }
      },
      {
        key: "llm_api",
        label: "LLM API",
        status: !hasValue(config.llm_api.apiKey)
          ? "needs_auth"
          : hasValue(config.llm_api.baseUrl) && !isValidHttpUrl(config.llm_api.baseUrl)
          ? "error"
          : "ready",
        detail: !hasValue(config.llm_api.apiKey)
          ? "Set LLM API key."
          : hasValue(config.llm_api.baseUrl) && !isValidHttpUrl(config.llm_api.baseUrl)
          ? "LLM base URL must be a valid http/https URL."
          : "LLM provider configuration is ready.",
        updated_at:
          configUpdatedByKey.get("llm_api") ??
          configUpdatedByKey.get("claude_local") ??
          now,
        editable: true,
        config: {
          provider: config.llm_api.provider,
          base_url: config.llm_api.baseUrl,
          default_model: config.llm_api.defaultModel,
          api_key_configured: hasValue(config.llm_api.apiKey)
        }
      },
      {
        key: "process",
        label: "Process Adapter",
        status: hasValue(config.process.command) ? "ready" : "not_configured",
        detail: `Command: ${config.process.command || "(not set)"}`,
        updated_at: configUpdatedByKey.get("process") ?? now,
        editable: true,
        config: {
          command: config.process.command
        }
      },
      {
        key: "http",
        label: "HTTP Adapter",
        status: hasValue(config.http.baseUrl) && hasValue(config.http.token) ? "ready" : "not_configured",
        detail: hasValue(config.http.baseUrl) && hasValue(config.http.token)
          ? "HTTP base URL and token configured."
          : "Set HTTP base URL and token.",
        updated_at: configUpdatedByKey.get("http") ?? now,
        editable: true,
        config: {
          base_url: config.http.baseUrl,
          token_configured: hasValue(config.http.token)
        }
      },
      {
        key: "orchestrator_daemon",
        label: "Orchestrator Daemon",
        status: orchestratorHeartbeat
          ? daemonHealthStatus(orchestratorHeartbeat.heartbeat_at, orchestratorThresholdSeconds)
          : "offline",
        detail: orchestratorHeartbeat
          ? `Heartbeat at ${orchestratorHeartbeat.heartbeat_at}`
          : "No heartbeat yet.",
        updated_at: orchestratorHeartbeat?.heartbeat_at ?? now,
        editable: false
      },
      {
        key: "research_daemon",
        label: "Research Daemon",
        status: researchHeartbeat
          ? daemonHealthStatus(researchHeartbeat.heartbeat_at, researchThresholdSeconds)
          : "offline",
        detail: researchHeartbeat
          ? `Heartbeat at ${researchHeartbeat.heartbeat_at}`
          : "No heartbeat yet.",
        updated_at: researchHeartbeat?.heartbeat_at ?? now,
        editable: false
      }
    ];
  });

  app.post<{
    Params: { key: EditableIntegrationKey };
    Body: Record<string, unknown>;
  }>("/integrations/:key/config", async (req, reply) => {
    const key = req.params.key;
    if (!["supabase", "llm_api", "process", "http"].includes(key)) {
      return reply.status(400).send({ ok: false, error: "Invalid integration key." });
    }

    const rows = await repo.listIntegrationConfigs();
    const existingRow = rows.find((row) => row.integration_key === key);
    const existing = (existingRow?.config_json ?? {}) as Record<string, unknown>;
    const body = req.body ?? {};

    let nextConfig: Record<string, unknown> = { ...existing };
    if (key === "supabase") {
      if (typeof body.url === "string") {
        nextConfig.url = body.url.trim();
      }
      if (typeof body.anonKey === "string" && body.anonKey.trim().length > 0) {
        nextConfig.anonKey = body.anonKey.trim();
      }
    } else if (key === "llm_api") {
      if (typeof body.provider === "string") {
        nextConfig.provider = normalizeProvider(body.provider);
      }
      if (typeof body.apiKey === "string" && body.apiKey.trim().length > 0) {
        nextConfig.apiKey = body.apiKey.trim();
      }
      if (typeof body.baseUrl === "string") {
        nextConfig.baseUrl = body.baseUrl.trim();
      }
      if (typeof body.defaultModel === "string") {
        nextConfig.defaultModel = body.defaultModel.trim();
      }
    } else if (key === "process") {
      if (typeof body.command === "string") {
        nextConfig.command = body.command.trim();
      }
    } else if (key === "http") {
      if (typeof body.baseUrl === "string") {
        nextConfig.baseUrl = body.baseUrl.trim();
      }
      if (typeof body.token === "string" && body.token.trim().length > 0) {
        nextConfig.token = body.token.trim();
      }
    }

    await repo.upsertIntegrationConfig(key, nextConfig);
    return { ok: true };
  });

  app.get("/metrics/costs", async () => {
    const rows = await repo.listRunUsageCosts(500);

    const byModel = new Map<string, { runs: number; cost_usd: number; input_tokens: number; output_tokens: number }>();
    const byAgent = new Map<string, { runs: number; cost_usd: number; input_tokens: number; output_tokens: number }>();
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const row of rows) {
      totalCost += row.cost_usd;
      totalInputTokens += row.input_tokens;
      totalOutputTokens += row.output_tokens;

      const modelBucket = byModel.get(row.model) ?? {
        runs: 0,
        cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0
      };
      modelBucket.runs += 1;
      modelBucket.cost_usd += row.cost_usd;
      modelBucket.input_tokens += row.input_tokens;
      modelBucket.output_tokens += row.output_tokens;
      byModel.set(row.model, modelBucket);

      const agentBucket = byAgent.get(row.agent_profile) ?? {
        runs: 0,
        cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0
      };
      agentBucket.runs += 1;
      agentBucket.cost_usd += row.cost_usd;
      agentBucket.input_tokens += row.input_tokens;
      agentBucket.output_tokens += row.output_tokens;
      byAgent.set(row.agent_profile, agentBucket);
    }

    const serialize = (
      entries: Iterable<[string, { runs: number; cost_usd: number; input_tokens: number; output_tokens: number }]>,
      keyLabel: "model" | "agent_profile"
    ) =>
      Array.from(entries)
        .map(([key, value]) => ({
          [keyLabel]: key,
          runs: value.runs,
          cost_usd: Number(value.cost_usd.toFixed(6)),
          input_tokens: value.input_tokens,
          output_tokens: value.output_tokens
        }))
        .sort((a, b) => (b.cost_usd as number) - (a.cost_usd as number));

    return {
      updated_at: new Date().toISOString(),
      estimated: true,
      totals: {
        runs: rows.length,
        cost_usd: Number(totalCost.toFixed(6)),
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens
      },
      by_model: serialize(byModel.entries(), "model"),
      by_agent_profile: serialize(byAgent.entries(), "agent_profile")
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

    const [research, artifacts, finalPayload] = await Promise.all([
      repo.listResearchDocumentsForRun(req.params.id),
      repo.listArtifactsForRun(req.params.id),
      repo.getRunFinalPayload(req.params.id)
    ]);
    return {
      ...detail,
      research,
      artifacts,
      final_payload: finalPayload
    };
  });

  app.get<{ Params: { id: string } }>("/runs/:id/events", async (req) => {
    return repo.listRunEvents(req.params.id);
  });

  app.get<{ Params: { id: string } }>("/artifacts/:id/preview", async (req, reply) => {
    const artifact = await repo.getArtifact(req.params.id);
    if (!artifact) {
      return reply.status(404).send({ error: "Artifact not found" });
    }

    try {
      const fileInfo = await stat(artifact.path);
      if (!fileInfo.isFile()) {
        return reply.status(400).send({ error: "Artifact path is not a file." });
      }

      if (isPreviewableImage(artifact.path)) {
        return {
          id: artifact.id,
          kind: "image",
          mime_type: contentTypeForArtifact(artifact.path),
          content_url: `/artifacts/${artifact.id}/content`
        };
      }

      if (isPreviewableText(artifact.path)) {
        const maxBytes = Math.min(MAX_TEXT_PREVIEW_BYTES, fileInfo.size);
        const content = await readFile(artifact.path, "utf8");
        const trimmed = content.slice(0, maxBytes);

        return {
          id: artifact.id,
          kind: "text",
          mime_type: contentTypeForArtifact(artifact.path),
          content: trimmed,
          truncated: content.length > trimmed.length
        };
      }

      return {
        id: artifact.id,
        kind: "binary",
        mime_type: contentTypeForArtifact(artifact.path),
        content_url: `/artifacts/${artifact.id}/content`
      };
    } catch (error) {
      return reply.status(404).send({ error: (error as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/artifacts/:id/content", async (req, reply) => {
    const artifact = await repo.getArtifact(req.params.id);
    if (!artifact) {
      return reply.status(404).send({ error: "Artifact not found" });
    }

    try {
      const fileInfo = await stat(artifact.path);
      if (!fileInfo.isFile()) {
        return reply.status(400).send({ error: "Artifact path is not a file." });
      }

      reply.header("content-disposition", `inline; filename=\"${path.basename(artifact.path)}\"`);
      reply.type(contentTypeForArtifact(artifact.path));
      return reply.send(createReadStream(artifact.path));
    } catch (error) {
      return reply.status(404).send({ error: (error as Error).message });
    }
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
  }>("/research/experiments", async (req) => {
    return repo.listResearchExperiments(200, req.query.status);
  });

  app.post<{
    Params: { id: string };
    Body: { status: ReviewStatus };
  }>("/research/experiments/:id/review", async (req, reply) => {
    const status = req.body?.status;
    if (!status || !["unreviewed", "accepted", "rejected"].includes(status)) {
      return reply.status(400).send({ error: "Invalid review status." });
    }
    await repo.setResearchExperimentReviewStatus(req.params.id, status);
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
