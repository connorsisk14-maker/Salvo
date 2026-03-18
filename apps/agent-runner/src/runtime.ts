import type { ContractV1 } from "@salvo/contracts";
import { validateContractV1 } from "@salvo/contracts";
import type { DbIntegrationConfig, DbRun, DbTask } from "@salvo/db";
import { buildSystemPrompt } from "@salvo/llm";
import {
  resolveLlmProviderAndModel,
  usageCostUsd,
  type LlmProvider as SharedLlmProvider
} from "@salvo/shared";
import { buildToolPolicy, type CommandExecutionResult, type FileReadResult, type ToolPolicy } from "@salvo/tools";
export type RunnerLlmProvider = SharedLlmProvider;

export type RunnerLlmConfig = {
  provider: RunnerLlmProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  temperature: number;
};

export type RunnerPromptContext = {
  workspace_listing: string;
  relevant_files: Array<{
    path: string;
    content: string;
  }>;
};

export type RunnerArtifact = {
  path: string;
  content: string;
  artifact_type?: string;
  label?: string;
};

export type RunnerLearning = {
  type: string;
  title: string;
  body: string;
};

export type RunnerModelOutput = {
  plan_steps: string[];
  summary: string;
  artifacts: RunnerArtifact[];
  learnings: RunnerLearning[];
};

export type RunnerUsage = {
  provider: RunnerLlmProvider;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  estimated: boolean;
  pricing_unit: "usd_per_1m_tokens";
};

export type RunnerLlmResult = {
  output: RunnerModelOutput;
  usage: RunnerUsage;
  raw_text: string;
};

type OpenAiMessage = {
  role: "system" | "user";
  content: string;
};

function readString(config: Record<string, unknown>, key: string, fallback = ""): string {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
}

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/");
}

export function validateRunnerContract(contractJson: Record<string, unknown>): ContractV1 {
  return validateContractV1(contractJson);
}

export function parseContractPolicy(
  workspaceRoot: string,
  contract: ContractV1
): ToolPolicy {
  const allowedCommands = contract.capabilities.run_tests
    ? ["echo", "ls", "cat", "pnpm", "npm", "node"]
    : ["echo", "ls", "cat"];

  return buildToolPolicy(workspaceRoot, {
    allowedReadPaths: contract.scope.read_paths,
    allowedWritePaths: contract.scope.write_paths,
    forbiddenPaths: contract.scope.forbidden_paths,
    allowedCommandCwds: ["."],
    allowedCommands,
    commandTimeoutMs: contract.constraints.max_runtime_minutes * 60_000
  });
}

export function reserveToolCall(
  currentToolCalls: number,
  maxToolCalls: number,
  tool: string
): number {
  const nextToolCalls = currentToolCalls + 1;
  if (nextToolCalls > maxToolCalls) {
    throw new Error(
      `Tool call limit exceeded for ${tool}. Allowed ${maxToolCalls} total tool calls.`
    );
  }
  return nextToolCalls;
}

export function resolveRunnerLlmConfig(input: {
  integrationConfigs: DbIntegrationConfig[];
  env: NodeJS.ProcessEnv;
  agentProfile: DbRun["agent_profile"];
}): RunnerLlmConfig {
  const llmConfigRow = input.integrationConfigs.find((row) => row.integration_key === "llm_api");
  const llmConfig = (llmConfigRow?.config_json ?? {}) as Record<string, unknown>;

  const routing = resolveLlmProviderAndModel({
    llmConfig,
    env: input.env,
    agentProfile: input.agentProfile
  });
  const apiKey =
    readString(llmConfig, "apiKey") ||
    readString(llmConfig, "authToken") ||
    input.env.SALVO_LLM_API_KEY ||
    input.env.SALVO_CLAUDE_AUTH_TOKEN ||
    "";
  const configuredBaseUrl = readString(llmConfig, "baseUrl", input.env.SALVO_LLM_BASE_URL);
  const baseUrl =
    configuredBaseUrl ||
    (routing.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1");
  const model = routing.model;

  if (!apiKey) {
    throw new Error("LLM API key is not configured for the agent runner.");
  }
  if (!model) {
    throw new Error("Default LLM model is not configured for the agent runner.");
  }

  return {
    provider: routing.provider,
    apiKey,
    model,
    baseUrl,
    temperature: 0.2
  };
}

function formatRelevantFileContext(context: RunnerPromptContext["relevant_files"]): string {
  if (context.length === 0) {
    return "No relevant files were provided in the contract context.";
  }

  return context
    .map((entry) => `## ${entry.path}\n${entry.content}`)
    .join("\n\n");
}

export function buildRunnerPrompts(input: {
  task: Pick<DbTask, "id" | "title" | "original_request">;
  run: Pick<DbRun, "id" | "agent_profile">;
  contract: ContractV1;
  context: RunnerPromptContext;
}): {
  systemPrompt: string;
  userPrompt: string;
} {
  const systemPrompt = buildSystemPrompt({
    contract: input.contract
  });

  const userPrompt = [
    `Run ID: ${input.run.id}`,
    `Task ID: ${input.task.id}`,
    `Agent profile: ${input.run.agent_profile}`,
    `Task title: ${input.task.title}`,
    `Task request:\n${input.task.original_request}`,
    `Contract:\n${JSON.stringify(input.contract, null, 2)}`,
    `Workspace listing:\n${input.context.workspace_listing}`,
    `Relevant file context:\n${formatRelevantFileContext(input.context.relevant_files)}`,
    "Produce at least one markdown artifact. If the contract requires run-summary.md, include it explicitly."
  ].join("\n\n");

  return {
    systemPrompt,
    userPrompt
  };
}

export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM response did not contain a JSON object.");
  }
  return candidate.slice(start, end + 1);
}

export function parseRunnerModelOutput(raw: string): RunnerModelOutput {
  const parsed = JSON.parse(extractJsonObject(raw)) as Partial<RunnerModelOutput>;
  const planSteps = Array.isArray(parsed.plan_steps)
    ? parsed.plan_steps.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const artifacts = Array.isArray(parsed.artifacts)
    ? parsed.artifacts
        .filter(
          (artifact): artifact is RunnerArtifact =>
            Boolean(
              artifact &&
                typeof artifact.path === "string" &&
                typeof artifact.content === "string" &&
                artifact.path.trim().length > 0
            )
        )
        .map((artifact) => ({
          path: normalizePath(artifact.path.trim()),
          content: artifact.content,
          artifact_type: artifact.artifact_type,
          label: artifact.label
        }))
    : [];
  const learnings = Array.isArray(parsed.learnings)
    ? parsed.learnings
        .filter(
          (learning): learning is RunnerLearning =>
            Boolean(
              learning &&
                typeof learning.type === "string" &&
                typeof learning.title === "string" &&
                typeof learning.body === "string"
            )
        )
        .map((learning) => ({
          type: learning.type.trim() || "note",
          title: learning.title.trim(),
          body: learning.body.trim()
        }))
        .filter((learning) => learning.title.length > 0 && learning.body.length > 0)
    : [];

  if (!summary) {
    throw new Error("LLM response did not include a summary.");
  }

  return {
    plan_steps: planSteps,
    summary,
    artifacts,
    learnings
  };
}

function parseOpenAiResponse(responseJson: Record<string, unknown>, config: RunnerLlmConfig): RunnerLlmResult {
  const choices = Array.isArray(responseJson.choices) ? responseJson.choices : [];
  const firstChoice = (choices[0] ?? {}) as {
    message?: {
      content?: string;
    };
  };
  const content = firstChoice.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("OpenAI-compatible response did not include message content.");
  }

  const usage = (responseJson.usage ?? {}) as {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  return {
    raw_text: content,
    output: parseRunnerModelOutput(content),
    usage: {
      provider: config.provider,
      model: config.model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: usageCostUsd(config.model, inputTokens, outputTokens),
      estimated: false,
      pricing_unit: "usd_per_1m_tokens"
    }
  };
}

function parseAnthropicResponse(responseJson: Record<string, unknown>, config: RunnerLlmConfig): RunnerLlmResult {
  const contentBlocks = Array.isArray(responseJson.content) ? responseJson.content : [];
  const text = contentBlocks
    .map((block) => (typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Anthropic response did not include text content.");
  }

  const usage = (responseJson.usage ?? {}) as {
    input_tokens?: number;
    output_tokens?: number;
  };
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    raw_text: text,
    output: parseRunnerModelOutput(text),
    usage: {
      provider: config.provider,
      model: config.model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: usageCostUsd(config.model, inputTokens, outputTokens),
      estimated: false,
      pricing_unit: "usd_per_1m_tokens"
    }
  };
}

export async function runLlmGeneration(input: {
  config: RunnerLlmConfig;
  systemPrompt: string;
  userPrompt: string;
}): Promise<RunnerLlmResult> {
  if (input.config.provider === "anthropic") {
    const response = await fetch(`${input.config.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": input.config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: input.config.model,
        max_tokens: 1800,
        temperature: input.config.temperature,
        system: input.systemPrompt,
        messages: [
          {
            role: "user",
            content: input.userPrompt
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic request failed: ${response.status} ${await response.text()}`);
    }

    return parseAnthropicResponse((await response.json()) as Record<string, unknown>, input.config);
  }

  const response = await fetch(`${input.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.config.apiKey}`
    },
    body: JSON.stringify({
      model: input.config.model,
      temperature: input.config.temperature,
      response_format: {
        type: "json_object"
      },
      messages: [
        {
          role: "system",
          content: input.systemPrompt
        },
        {
          role: "user",
          content: input.userPrompt
        }
      ] satisfies OpenAiMessage[]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI-compatible request failed: ${response.status} ${await response.text()}`);
  }

  return parseOpenAiResponse((await response.json()) as Record<string, unknown>, input.config);
}

export async function collectPromptContext(input: {
  relevantFiles: string[];
  listDirectory: (targetPath?: string) => Promise<FileReadResult>;
  readFile: (targetPath: string) => Promise<FileReadResult>;
}): Promise<RunnerPromptContext> {
  const listing = await input.listDirectory(".");
  const relevantFiles: RunnerPromptContext["relevant_files"] = [];

  for (const filePath of input.relevantFiles.slice(0, 5)) {
    const file = await input.readFile(filePath);
    if (!file.ok) {
      continue;
    }

    relevantFiles.push({
      path: normalizePath(filePath),
      content: file.content.slice(0, 8_000)
    });
  }

  return {
    workspace_listing: listing.ok ? listing.content : listing.decision.message,
    relevant_files: relevantFiles
  };
}

export function normalizeArtifacts(output: RunnerModelOutput, contract: ContractV1): RunnerArtifact[] {
  const requiredArtifacts = contract.deliverables.required_artifacts.map((artifact) =>
    normalizePath(artifact)
  );
  const deduped = new Map<string, RunnerArtifact>();

  for (const artifact of output.artifacts) {
    deduped.set(normalizePath(artifact.path), {
      ...artifact,
      path: normalizePath(artifact.path),
      artifact_type: artifact.artifact_type ?? "markdown"
    });
  }

  for (const requiredArtifact of requiredArtifacts) {
    if (!deduped.has(requiredArtifact)) {
      deduped.set(requiredArtifact, {
        path: requiredArtifact,
        content: output.summary,
        artifact_type: requiredArtifact.endsWith(".json") ? "json" : "markdown",
        label: requiredArtifact
      });
    }
  }

  if (deduped.size === 0) {
    deduped.set("run-summary.md", {
      path: "run-summary.md",
      content: output.summary,
      artifact_type: "markdown",
      label: "run summary"
    });
  }

  return Array.from(deduped.values());
}

export function commandEvidence(command: string, result: CommandExecutionResult): Record<string, unknown> {
  if (!result.ok) {
    return {
      command,
      denied: true,
      reason: result.decision.reason,
      message: result.decision.message
    };
  }

  return {
    command,
    exit_code: result.exitCode,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    duration_ms: result.durationMs
  };
}
