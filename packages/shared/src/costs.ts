import type { AgentProfile } from "./runtime";

const MODEL_BY_PROVIDER_AND_PROFILE = {
  openai: {
    builder: "gpt-5-mini",
    researcher: "gpt-5",
    debugger: "gpt-5-mini",
    documenter: "gpt-5-nano"
  },
  custom: {
    builder: "gpt-5-mini",
    researcher: "gpt-5",
    debugger: "gpt-5-mini",
    documenter: "gpt-5-nano"
  },
  anthropic: {
    builder: "claude-3-5-sonnet-latest",
    researcher: "claude-3-5-sonnet-latest",
    debugger: "claude-3-5-sonnet-latest",
    documenter: "claude-3-5-haiku-latest"
  }
} as const satisfies Record<LlmProvider, Record<AgentProfile, string>>;

const MODEL_PRICING_USD_PER_1M = [
  {
    matchers: ["gpt-5-mini"],
    input: 0.3,
    output: 1.2
  },
  {
    matchers: ["gpt-5-nano"],
    input: 0.05,
    output: 0.2
  },
  {
    matchers: ["gpt-5"],
    input: 1.25,
    output: 10
  },
  {
    matchers: ["claude-3-5-haiku", "claude-3-haiku"],
    input: 0.8,
    output: 4
  },
  {
    matchers: ["claude-3-5-sonnet", "claude-3-7-sonnet", "claude-sonnet-4"],
    input: 3,
    output: 15
  }
] as const;

const OUTPUT_TOKEN_ESTIMATE_BY_PROFILE = {
  builder: 1_800,
  researcher: 2_800,
  debugger: 1_600,
  documenter: 1_200
} as const satisfies Record<AgentProfile, number>;

export type LlmProvider = "anthropic" | "openai" | "custom";

function readString(config: Record<string, unknown>, key: string, fallback = ""): string {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
}

export function normalizeLlmProvider(input: string | undefined): LlmProvider {
  if (input === "openai" || input === "custom" || input === "anthropic") {
    return input;
  }
  return "anthropic";
}

export function resolveLlmProviderAndModel(input: {
  llmConfig?: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  agentProfile: AgentProfile;
}): {
  provider: LlmProvider;
  model: string;
} {
  const llmConfig = input.llmConfig ?? {};
  const provider = normalizeLlmProvider(
    readString(llmConfig, "provider", input.env.SALVO_LLM_PROVIDER)
  );
  const model =
    readString(llmConfig, "defaultModel", input.env.SALVO_LLM_DEFAULT_MODEL) ||
    MODEL_BY_PROVIDER_AND_PROFILE[provider][input.agentProfile];

  return {
    provider,
    model
  };
}

export function usageCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const normalizedModel = model.toLowerCase();
  const pricing = MODEL_PRICING_USD_PER_1M.find((entry) =>
    entry.matchers.some((matcher) => normalizedModel.includes(matcher))
  );
  if (!pricing) {
    return 0;
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return Number((inputCost + outputCost).toFixed(6));
}

export function estimateRunCost(input: {
  model: string;
  agentProfile: AgentProfile;
  title: string;
  request: string;
  contractJson?: Record<string, unknown>;
  relevantFileCount?: number;
  recentRunCount?: number;
  memoryExcerptCount?: number;
}): {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  estimated: true;
  pricing_unit: "usd_per_1m_tokens";
  heuristic: string;
} {
  const contractSize = JSON.stringify(input.contractJson ?? {}).length;
  const promptChars = input.title.length + input.request.length + contractSize;
  const promptTokens = Math.ceil(promptChars / 4);
  const contextTokens =
    900 +
    (input.relevantFileCount ?? 0) * 250 +
    (input.recentRunCount ?? 0) * 80 +
    (input.memoryExcerptCount ?? 0) * 40;
  const inputTokens = Math.max(700, promptTokens + contextTokens);
  const outputTokens = OUTPUT_TOKEN_ESTIMATE_BY_PROFILE[input.agentProfile];

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: usageCostUsd(input.model, inputTokens, outputTokens),
    estimated: true,
    pricing_unit: "usd_per_1m_tokens",
    heuristic: "char_estimate_v1"
  };
}
