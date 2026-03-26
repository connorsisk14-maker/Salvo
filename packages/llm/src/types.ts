export const LLM_PROVIDERS = ["anthropic", "openai", "custom"] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export type LlmPricing = {
  provider: LlmProvider;
  inputUsdPer1mTokens: number;
  outputUsdPer1mTokens: number;
};

export const MODEL_CATALOG = {
  "gpt-5.4-mini": {
    provider: "openai",
    inputUsdPer1mTokens: 0.25,
    outputUsdPer1mTokens: 2
  },
  "gpt-5.4": {
    provider: "openai",
    inputUsdPer1mTokens: 2.5,
    outputUsdPer1mTokens: 15
  },
  "gpt-5-mini": {
    provider: "openai",
    inputUsdPer1mTokens: 0.25,
    outputUsdPer1mTokens: 2
  },
  "gpt-5-nano": {
    provider: "openai",
    inputUsdPer1mTokens: 0.05,
    outputUsdPer1mTokens: 0.4
  },
  "gpt-5": {
    provider: "openai",
    inputUsdPer1mTokens: 1.25,
    outputUsdPer1mTokens: 10
  },
  "gpt-4o-mini": {
    provider: "openai",
    inputUsdPer1mTokens: 0.15,
    outputUsdPer1mTokens: 0.6
  },
  "gpt-4o": {
    provider: "openai",
    inputUsdPer1mTokens: 2.5,
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

export type LlmStreamChunk =
  | {
      type: "response.started";
      provider: LlmProvider;
      model: string;
      responseId?: string;
    }
  | {
      type: "text_delta";
      text: string;
    }
  | {
      type: "response.completed";
      response: LlmResponse;
    };

export function resolveModelPricing(model: string): LlmPricing | null {
  const normalizedModel = model.toLowerCase();

  const orderedEntries = Object.entries(MODEL_CATALOG).sort((left, right) => right[0].length - left[0].length);
  for (const [catalogModel, pricing] of orderedEntries) {
    if (normalizedModel.includes(catalogModel)) {
      return pricing;
    }
  }

  return null;
}

/** Wire format for tool definitions sent to Anthropic-compatible endpoints. */
export type ProviderToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

/** Wire format for requests sent to Anthropic-compatible endpoints. */
export type ProviderMessageRequest = {
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
  tools?: ProviderToolDefinition[];
};

// Backward-compatible aliases.
export type AnthropicToolDefinition = ProviderToolDefinition;
export type AnthropicMessageRequest = ProviderMessageRequest;

export type OpenAiToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type OpenAiChatMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

export type OpenAiChatCompletionRequest = {
  model: string;
  max_tokens?: number;
  temperature?: number;
  messages: OpenAiChatMessage[];
  tools?: OpenAiToolDefinition[];
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
};
