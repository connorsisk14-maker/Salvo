import type {
  AnthropicMessageRequest,
  AnthropicToolDefinition,
  LlmConfig,
  LlmContentBlock,
  LlmMessage,
  LlmResponse,
  LlmToolDefinition
} from "./types";

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 1024;

type FetchLike = typeof fetch;

export class LlmRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = "LlmRequestError";
  }
}

export class LlmAuthError extends LlmRequestError {
  constructor(status: number, body: string) {
    super(`Anthropic auth failed (${status})`, status, body);
    this.name = "LlmAuthError";
  }
}

export class LlmRateLimitError extends LlmRequestError {
  constructor(status: number, body: string) {
    super(`Anthropic rate limit hit (${status})`, status, body);
    this.name = "LlmRateLimitError";
  }
}

export class LlmServerError extends LlmRequestError {
  constructor(status: number, body: string) {
    super(`Anthropic server error (${status})`, status, body);
    this.name = "LlmServerError";
  }
}

function toAnthropicTools(tools: LlmToolDefinition[] | undefined): AnthropicToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  }));
}

function toAnthropicContentBlocks(content: LlmMessage["content"]): AnthropicMessageRequest["messages"][number]["content"] {
  if (typeof content === "string") {
    return content;
  }

  const blocks: Array<
    { type: "text"; text: string } |
    { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  > = [];

  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }

    if (block.type === "tool_result") {
      blocks.push({
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError
      });
    }
  }

  return blocks;
}

function toAnthropicMessages(messages: LlmMessage[]): AnthropicMessageRequest["messages"] {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: toAnthropicContentBlocks(message.content)
  }));
}

function parseAnthropicContentBlocks(raw: unknown): LlmContentBlock[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const blocks: LlmContentBlock[] = [];

  for (const block of raw) {
    if (typeof block !== "object" || block === null) {
      continue;
    }

    const type = (block as { type?: unknown }).type;
    if (type === "text" && typeof (block as { text?: unknown }).text === "string") {
      blocks.push({
        type: "text",
        text: (block as { text: string }).text
      });
      continue;
    }

    if (
      type === "tool_use" &&
      typeof (block as { id?: unknown }).id === "string" &&
      typeof (block as { name?: unknown }).name === "string" &&
      typeof (block as { input?: unknown }).input === "object" &&
      (block as { input?: unknown }).input !== null
    ) {
      blocks.push({
        type: "tool_use",
        id: (block as { id: string }).id,
        name: (block as { name: string }).name,
        input: (block as { input: Record<string, unknown> }).input
      });
    }
  }

  return blocks;
}

export class LlmClient {
  constructor(
    private readonly config: LlmConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {
    if (config.provider !== "anthropic") {
      throw new Error("LlmClient currently supports only the anthropic provider.");
    }
  }

  async createMessage(
    system: string,
    messages: LlmMessage[],
    tools?: LlmToolDefinition[]
  ): Promise<LlmResponse> {
    const body: AnthropicMessageRequest = {
      model: this.config.model,
      max_tokens: this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: this.config.temperature,
      system,
      messages: toAnthropicMessages(messages),
      tools: toAnthropicTools(tools)
    };

    const response = await this.fetchImpl(
      `${(this.config.baseUrl || DEFAULT_ANTHROPIC_BASE_URL).replace(/\/$/, "")}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version":
            this.config.headers?.["anthropic-version"] ?? DEFAULT_ANTHROPIC_VERSION,
          ...this.config.headers
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      const responseBody = await response.text();
      if (response.status === 401 || response.status === 403) {
        throw new LlmAuthError(response.status, responseBody);
      }
      if (response.status === 429) {
        throw new LlmRateLimitError(response.status, responseBody);
      }
      if (response.status >= 500) {
        throw new LlmServerError(response.status, responseBody);
      }
      throw new LlmRequestError(
        `Anthropic request failed (${response.status})`,
        response.status,
        responseBody
      );
    }

    const responseJson = (await response.json()) as Record<string, unknown>;
    const usage = (responseJson.usage ?? {}) as {
      input_tokens?: number;
      output_tokens?: number;
    };

    return {
      id: typeof responseJson.id === "string" ? responseJson.id : undefined,
      provider: "anthropic",
      model:
        typeof responseJson.model === "string" ? responseJson.model : this.config.model,
      stopReason:
        typeof responseJson.stop_reason === "string"
          ? responseJson.stop_reason
          : null,
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0
      },
      content: parseAnthropicContentBlocks(responseJson.content),
      raw: responseJson
    };
  }
}
