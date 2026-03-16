import { readdir } from "node:fs/promises";
import { buildContractV1, validateContractV1, type ContractV1 } from "@salvo/contracts";
import type { DbContractMemoryPrompt, DbIntegrationConfig, DbTask, DbWorkspace } from "@salvo/db";
import {
  LlmClient,
  type LlmConfig,
  type LlmMessage,
  type LlmResponse
} from "@salvo/llm";
import { resolveLlmProviderAndModel } from "@salvo/shared";

const MAX_WORKSPACE_ENTRIES = 12;
const MAX_MEMORY_BODY_CHARS = 600;
const DEFAULT_CONTRACT_MODEL = "claude-3-5-sonnet-latest";

function readString(config: Record<string, unknown>, key: string, fallback = ""): string {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
}

export type ContractPlanningResult = {
  contract: ContractV1;
  source: "llm" | "fallback";
  reason?: string;
  rawText?: string;
};

export type ContractPlanningClient = {
  createMessage(
    system: string,
    messages: LlmMessage[]
  ): Promise<LlmResponse>;
};

function stripJsonFences(input: string): string {
  return input
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractJsonObject(input: string): string {
  const trimmed = stripJsonFences(input);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("LLM response did not contain a JSON object.");
  }
  return trimmed.slice(first, last + 1);
}

function parseContractResponseText(text: string): ContractV1 {
  const parsed = JSON.parse(extractJsonObject(text)) as unknown;
  return validateContractV1(parsed);
}

export async function collectWorkspaceSnapshot(workspacePath: string): Promise<string[]> {
  try {
    const entries = await readdir(workspacePath, { withFileTypes: true });
    return entries
      .slice(0, MAX_WORKSPACE_ENTRIES)
      .map((entry) => `${entry.isDirectory() ? "dir" : "file"}:${entry.name}`);
  } catch {
    return [];
  }
}

export function buildContractPlanningPrompts(input: {
  task: Pick<DbTask, "id" | "workspace_id" | "title" | "original_request">;
  workspace: Pick<DbWorkspace, "id" | "name" | "local_path">;
  baseContract: ContractV1;
  workspaceEntries: string[];
  memories: DbContractMemoryPrompt[];
}): {
  system: string;
  user: string;
} {
  const system = [
    "You are the Salvo orchestrator.",
    "Return only a valid JSON object that fully satisfies the ContractV1 schema.",
    "Use the provided contract_id, task_id, workspace_id, and created_at exactly as given.",
    "Derive risk, scope, capabilities, constraints, deliverables, and success criteria from the task rather than generic defaults.",
    "Keep family_key unchanged when the task matches the provided family memory.",
    "Use task-specific read_paths, write_paths, forbidden_paths, and required_test_commands.",
    "If memory excerpts are relevant, include their ids in context.memory_excerpt_ids and related source runs in context.recent_runs."
  ].join(" ");

  const user = JSON.stringify(
    {
      task: {
        id: input.task.id,
        workspace_id: input.task.workspace_id,
        title: input.task.title,
        request: input.task.original_request
      },
      workspace: {
        id: input.workspace.id,
        name: input.workspace.name,
        local_path: input.workspace.local_path,
        top_level_entries: input.workspaceEntries
      },
      accepted_family_memories: input.memories.map((memory) => ({
        id: memory.id,
        title: memory.title,
        summary: memory.summary,
        body_markdown: memory.body_markdown.slice(0, MAX_MEMORY_BODY_CHARS),
        confidence: memory.confidence,
        source_run_ids: memory.source_run_ids
      })),
      base_contract: input.baseContract
    },
    null,
    2
  );

  return { system, user };
}

export function resolveContractPlannerConfig(input: {
  integrationConfigs: DbIntegrationConfig[];
  env: NodeJS.ProcessEnv;
}): LlmConfig | null {
  const llmConfig = input.integrationConfigs.find((row) => row.integration_key === "llm_api")
    ?.config_json as Record<string, unknown> | undefined;
  const routing = resolveLlmProviderAndModel({
    llmConfig,
    env: input.env,
    agentProfile: "builder"
  });

  if (routing.provider !== "anthropic") {
    return null;
  }

  const apiKey =
    readString(llmConfig ?? {}, "apiKey") ||
    readString(llmConfig ?? {}, "authToken") ||
    input.env.SALVO_LLM_API_KEY ||
    input.env.SALVO_CLAUDE_AUTH_TOKEN ||
    "";
  if (!apiKey) {
    return null;
  }

  return {
    provider: "anthropic",
    apiKey,
    baseUrl:
      readString(llmConfig ?? {}, "baseUrl", input.env.SALVO_LLM_BASE_URL) ||
      "https://api.anthropic.com",
    model: routing.model || DEFAULT_CONTRACT_MODEL,
    maxTokens: 1800,
    temperature: 0.1
  };
}

export async function planContract(input: {
  task: Pick<DbTask, "id" | "workspace_id" | "title" | "original_request">;
  workspace: Pick<DbWorkspace, "id" | "name" | "local_path">;
  baseContract: ContractV1;
  workspaceEntries: string[];
  memories: DbContractMemoryPrompt[];
  llmConfig: LlmConfig | null;
  client?: ContractPlanningClient;
}): Promise<ContractPlanningResult> {
  if (!input.llmConfig) {
    return {
      contract: input.baseContract,
      source: "fallback",
      reason: "llm_not_configured"
    };
  }

  const client = input.client ?? new LlmClient(input.llmConfig);
  const prompts = buildContractPlanningPrompts(input);

  try {
    const response = await client.createMessage(prompts.system, [
      {
        role: "user",
        content: prompts.user
      }
    ]);
    const rawText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    const contract = parseContractResponseText(rawText);
    return {
      contract,
      source: "llm",
      rawText
    };
  } catch (error) {
    return {
      contract: input.baseContract,
      source: "fallback",
      reason: (error as Error).message
    };
  }
}

export function buildHeuristicContract(input: {
  contractId: string;
  taskId: string;
  workspaceId: string;
  request: string;
  taskTitle: string;
}): ContractV1 {
  return buildContractV1({
    contractId: input.contractId,
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    request: input.request,
    taskTitle: input.taskTitle,
    preferredProfile: "builder"
  });
}
