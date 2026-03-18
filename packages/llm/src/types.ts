export const LLM_PROVIDERS = ["anthropic", "openai", "custom"] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export type LlmPricing = {
  provider: LlmProvider;
  inputUsdPer1mTokens: number;
  outputUsdPer1mTokens: number;
};

export const MODEL_CATALOG = {
  "gpt-5-mini": {
    provider: "openai",
    inputUsdPer1mTokens: 0.3,
    outputUsdPer1mTokens: 1.2
  },
  "gpt-5-nano": {
    provider: "openai",
    inputUsdPer1mTokens: 0.05,
    outputUsdPer1mTokens: 0.2
  },
  "gpt-5": {
    provider: "openai",
    inputUsdPer1mTokens: 1.25,
    outputUsdPer1mTokens: 10
  },
  "claude-3-5-haiku": {
    provider: "anthropic",
    inputUsdPer1mTokens: 0.8,
    outputUsdPer1mTokens: 4
  },
  "claude-3-haiku": {
    provider: "anthropic",
    inputUsdPer1mTokens: 0.8,
    outputUsdPer1mTokens: 4
  },
  "claude-3-5-sonnet": {
    provider: "anthropic",
    inputUsdPer1mTokens: 3,
    outputUsdPer1mTokens: 15
  },
  "claude-3-7-sonnet": {
    provider: "anthropic",
    inputUsdPer1mTokens: 3,
    outputUsdPer1mTokens: 15
  },
  "claude-sonnet-4": {
    provider: "anthropic",
    inputUsdPer1mTokens: 3,
    outputUsdPer1mTokens: 15
  }
} as const satisfies Record<string, LlmPricing>;

export type LlmModel = keyof typeof MODEL_CATALOG;

export type LlmConfig = {
  provider: LlmProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
};

export type LlmToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type LlmContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError?: boolean;
    };

export type LlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | LlmContentBlock[];
};

export type LlmResponse = {
  id?: string;
  provider: LlmProvider;
  model: string;
  stopReason?: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  content: LlmContentBlock[];
  raw: Record<string, unknown>;
};

export function resolveModelPricing(model: string): LlmPricing | null {
  const normalizedModel = model.toLowerCase();

  for (const [catalogModel, pricing] of Object.entries(MODEL_CATALOG)) {
    if (normalizedModel.includes(catalogModel)) {
      return pricing;
    }
  }

  return null;
}

export type AnthropicToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type AnthropicMessageRequest = {
  model: string;
  max_tokens: number;
  temperature?: number;
  system?: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string | Array<
      | { type: "text"; text: string }
      | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
    >;
  }>;
  tools?: AnthropicToolDefinition[];
};
