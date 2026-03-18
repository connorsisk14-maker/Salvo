import type {
  LlmConfig,
  LlmContentBlock,
  LlmMessage,
  LlmResponse,
  LlmStreamChunk,
  LlmToolDefinition,
  OpenAiChatCompletionRequest,
  OpenAiChatMessage,
  OpenAiToolDefinition,
  ProviderMessageRequest,
  ProviderToolDefinition
} from "./types";

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 1024;

type FetchLike = typeof fetch;

type OpenAiToolCallAccumulator = {
  id: string;
  name: string;
  argumentsText: string;
};

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
    super(`LLM auth failed (${status})`, status, body);
    this.name = "LlmAuthError";
  }
}

export class LlmRateLimitError extends LlmRequestError {
  constructor(status: number, body: string) {
    super(`LLM rate limit hit (${status})`, status, body);
    this.name = "LlmRateLimitError";
  }
}

export class LlmServerError extends LlmRequestError {
  constructor(status: number, body: string) {
    super(`LLM server error (${status})`, status, body);
    this.name = "LlmServerError";
  }
}

function buildApiUrl(baseUrl: string | undefined, fallbackBaseUrl: string, path: string): string {
  const base = (baseUrl || fallbackBaseUrl).replace(/\/$/, "");
  if (base.endsWith("/v1")) {
    return `${base}${path}`;
  }
  return `${base}/v1${path}`;
}

function buildHttpError(status: number, responseBody: string): LlmRequestError {
  if (status === 401 || status === 403) {
    return new LlmAuthError(status, responseBody);
  }
  if (status === 429) {
    return new LlmRateLimitError(status, responseBody);
  }
  if (status >= 500) {
    return new LlmServerError(status, responseBody);
  }
  return new LlmRequestError(`LLM request failed (${status})`, status, responseBody);
}

function toProviderTools(tools: LlmToolDefinition[] | undefined): ProviderToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  }));
}

function toOpenAiTools(tools: LlmToolDefinition[] | undefined): OpenAiToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
}

function toProviderContentBlocks(content: LlmMessage["content"]): ProviderMessageRequest["messages"][number]["content"] {
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

function toProviderMessages(messages: LlmMessage[]): ProviderMessageRequest["messages"] {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: toProviderContentBlocks(message.content)
  }));
}

function toOpenAiMessages(system: string, messages: LlmMessage[]): OpenAiChatMessage[] {
  const result: OpenAiChatMessage[] = [{ role: "system", content: system }];

  for (const message of messages) {
    if (message.role === "tool") {
      const toolResults = typeof message.content === "string" ? [] : message.content;
      for (const block of toolResults) {
        if (block.type !== "tool_result") {
          continue;
        }
        result.push({
          role: "tool",
          tool_call_id: block.toolUseId,
          content: block.content
        });
      }
      continue;
    }

    if (typeof message.content === "string") {
      result.push({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content
      });
      continue;
    }

    const textBlocks = message.content.flatMap((block) =>
      block.type === "text" ? [block.text] : []
    );

    if (message.role === "assistant") {
      const toolCalls = message.content.flatMap((block) =>
        block.type === "tool_use"
          ? [{
              id: block.id,
              type: "function" as const,
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input)
              }
            }]
          : []
      );

      result.push({
        role: "assistant",
        content: textBlocks.length > 0 ? textBlocks.join("\n") : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      });
      continue;
    }

    result.push({
      role: "user",
      content: textBlocks.join("\n")
    });
  }

  return result;
}

function parseProviderContentBlocks(raw: unknown): LlmContentBlock[] {
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

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw };
  }
}

function parseOpenAiToolCalls(raw: unknown): LlmContentBlock[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const toolBlocks: LlmContentBlock[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const id = (entry as { id?: unknown }).id;
    const fn = (entry as { function?: unknown }).function;
    const name = typeof (fn as { name?: unknown } | undefined)?.name === "string"
      ? (fn as { name: string }).name
      : null;
    const argumentsText = typeof (fn as { arguments?: unknown } | undefined)?.arguments === "string"
      ? (fn as { arguments: string }).arguments
      : null;

    if (typeof id !== "string" || !name || argumentsText === null) {
      continue;
    }

    toolBlocks.push({
      type: "tool_use",
      id,
      name,
      input: parseJsonObject(argumentsText)
    });
  }

  return toolBlocks;
}

function parseOpenAiResponse(responseJson: Record<string, unknown>, provider: LlmConfig["provider"], fallbackModel: string): LlmResponse {
  const choices = Array.isArray(responseJson.choices) ? responseJson.choices : [];
  const firstChoice = (choices[0] ?? {}) as {
    finish_reason?: unknown;
    message?: {
      content?: unknown;
      tool_calls?: unknown;
    };
  };
  const textContent = typeof firstChoice.message?.content === "string" ? firstChoice.message.content : "";
  const usage = (responseJson.usage ?? {}) as {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  const content: LlmContentBlock[] = [];

  if (textContent.trim().length > 0) {
    content.push({
      type: "text",
      text: textContent
    });
  }

  content.push(...parseOpenAiToolCalls(firstChoice.message?.tool_calls));

  return {
    id: typeof responseJson.id === "string" ? responseJson.id : undefined,
    provider,
    model: typeof responseJson.model === "string" ? responseJson.model : fallbackModel,
    stopReason:
      typeof firstChoice.finish_reason === "string" ? firstChoice.finish_reason : null,
    usage: {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0
    },
    content,
    raw: responseJson
  };
}

async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      separatorIndex = buffer.indexOf("\n\n");

      const lines = rawEvent.split(/\r?\n/);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice("event:".length).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim());
        }
      }

      if (dataLines.length > 0) {
        yield {
          event,
          data: dataLines.join("\n")
        };
      }
    }

    if (done) {
      break;
    }
  }
}

function ensureResponseBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) {
    throw new Error("LLM streaming response did not include a readable body.");
  }
  return response.body;
}

export class LlmClient {
  constructor(
    private readonly config: LlmConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async createMessage(
    system: string,
    messages: LlmMessage[],
    tools?: LlmToolDefinition[]
  ): Promise<LlmResponse> {
    if (this.config.provider === "openai" || this.config.provider === "custom") {
      return this.createMessageOpenAi(system, messages, tools);
    }
    return this.createMessageAnthropic(system, messages, tools);
  }

  async *streamMessage(
    system: string,
    messages: LlmMessage[],
    tools?: LlmToolDefinition[]
  ): AsyncGenerator<LlmStreamChunk> {
    if (this.config.provider === "openai" || this.config.provider === "custom") {
      yield* this.streamMessageOpenAi(system, messages, tools);
      return;
    }

    yield* this.streamMessageAnthropic(system, messages, tools);
  }

  private async createMessageAnthropic(
    system: string,
    messages: LlmMessage[],
    tools?: LlmToolDefinition[]
  ): Promise<LlmResponse> {
    const body: ProviderMessageRequest = {
      model: this.config.model,
      max_tokens: this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: this.config.temperature,
      system,
      messages: toProviderMessages(messages),
      tools: toProviderTools(tools)
    };

    const response = await this.fetchImpl(
      buildApiUrl(this.config.baseUrl, DEFAULT_ANTHROPIC_BASE_URL, "/messages"),
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
      throw buildHttpError(response.status, await response.text());
    }

    const responseJson = (await response.json()) as Record<string, unknown>;
    const usage = (responseJson.usage ?? {}) as {
      input_tokens?: number;
      output_tokens?: number;
    };

    return {
      id: typeof responseJson.id === "string" ? responseJson.id : undefined,
      provider: this.config.provider,
      model: typeof responseJson.model === "string" ? responseJson.model : this.config.model,
      stopReason: typeof responseJson.stop_reason === "string" ? responseJson.stop_reason : null,
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0
      },
      content: parseProviderContentBlocks(responseJson.content),
      raw: responseJson
    };
  }

  private async createMessageOpenAi(
    system: string,
    messages: LlmMessage[],
    tools?: LlmToolDefinition[]
  ): Promise<LlmResponse> {
    const body: OpenAiChatCompletionRequest = {
      model: this.config.model,
      max_tokens: this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: this.config.temperature,
      messages: toOpenAiMessages(system, messages),
      tools: toOpenAiTools(tools)
    };

    const response = await this.fetchImpl(
      buildApiUrl(this.config.baseUrl, DEFAULT_OPENAI_BASE_URL, "/chat/completions"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
          ...this.config.headers
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      throw buildHttpError(response.status, await response.text());
    }

    return parseOpenAiResponse(
      (await response.json()) as Record<string, unknown>,
      this.config.provider,
      this.config.model
    );
  }

  private async *streamMessageAnthropic(
    system: string,
    messages: LlmMessage[],
    tools?: LlmToolDefinition[]
  ): AsyncGenerator<LlmStreamChunk> {
    const response = await this.fetchImpl(
      buildApiUrl(this.config.baseUrl, DEFAULT_ANTHROPIC_BASE_URL, "/messages"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version":
            this.config.headers?.["anthropic-version"] ?? DEFAULT_ANTHROPIC_VERSION,
          ...this.config.headers
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
          temperature: this.config.temperature,
          system,
          messages: toProviderMessages(messages),
          tools: toProviderTools(tools),
          stream: true
        })
      }
    );

    if (!response.ok) {
      throw buildHttpError(response.status, await response.text());
    }

    const content: LlmContentBlock[] = [];
    let responseId: string | undefined;
    let model = this.config.model;
    let stopReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let currentTextIndex = -1;
    let started = false;

    for await (const event of readSseEvents(ensureResponseBody(response))) {
      if (event.data === "[DONE]") {
        break;
      }

      const payload = JSON.parse(event.data) as Record<string, unknown>;
      const type = typeof payload.type === "string" ? payload.type : event.event;

      if (type === "message_start") {
        const message = (payload.message ?? {}) as Record<string, unknown>;
        responseId = typeof message.id === "string" ? message.id : responseId;
        model = typeof message.model === "string" ? message.model : model;
        const usage = (message.usage ?? {}) as { input_tokens?: number };
        inputTokens = usage.input_tokens ?? inputTokens;

        if (!started) {
          started = true;
          yield {
            type: "response.started",
            provider: this.config.provider,
            model,
            responseId
          };
        }
        continue;
      }

      if (type === "content_block_start") {
        const block = (payload.content_block ?? {}) as Record<string, unknown>;
        if (block.type === "text") {
          content.push({
            type: "text",
            text: typeof block.text === "string" ? block.text : ""
          });
          currentTextIndex = content.length - 1;
        }
        continue;
      }

      if (type === "content_block_delta") {
        const delta = (payload.delta ?? {}) as Record<string, unknown>;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          if (currentTextIndex === -1) {
            content.push({ type: "text", text: "" });
            currentTextIndex = content.length - 1;
          }

          const current = content[currentTextIndex];
          if (current?.type === "text") {
            current.text += delta.text;
          }

          yield {
            type: "text_delta",
            text: delta.text
          };
        }
        continue;
      }

      if (type === "message_delta") {
        const delta = (payload.delta ?? {}) as Record<string, unknown>;
        if (typeof delta.stop_reason === "string") {
          stopReason = delta.stop_reason;
        }
        const usage = (payload.usage ?? {}) as { output_tokens?: number };
        outputTokens = usage.output_tokens ?? outputTokens;
      }
    }

    yield {
      type: "response.completed",
      response: {
        id: responseId,
        provider: this.config.provider,
        model,
        stopReason,
        usage: {
          inputTokens,
          outputTokens
        },
        content,
        raw: {}
      }
    };
  }

  private async *streamMessageOpenAi(
    system: string,
    messages: LlmMessage[],
    tools?: LlmToolDefinition[]
  ): AsyncGenerator<LlmStreamChunk> {
    const response = await this.fetchImpl(
      buildApiUrl(this.config.baseUrl, DEFAULT_OPENAI_BASE_URL, "/chat/completions"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
          ...this.config.headers
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
          temperature: this.config.temperature,
          messages: toOpenAiMessages(system, messages),
          tools: toOpenAiTools(tools),
          stream: true,
          stream_options: {
            include_usage: true
          }
        } satisfies OpenAiChatCompletionRequest)
      }
    );

    if (!response.ok) {
      throw buildHttpError(response.status, await response.text());
    }

    let responseId: string | undefined;
    let model = this.config.model;
    let stopReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let started = false;
    let fullText = "";
    const toolCalls = new Map<number, OpenAiToolCallAccumulator>();

    for await (const event of readSseEvents(ensureResponseBody(response))) {
      if (event.data === "[DONE]") {
        break;
      }

      const payload = JSON.parse(event.data) as Record<string, unknown>;
      responseId = typeof payload.id === "string" ? payload.id : responseId;
      model = typeof payload.model === "string" ? payload.model : model;

      if (!started) {
        started = true;
        yield {
          type: "response.started",
          provider: this.config.provider,
          model,
          responseId
        };
      }

      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const usage = (payload.usage ?? {}) as {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
      inputTokens = usage.prompt_tokens ?? inputTokens;
      outputTokens = usage.completion_tokens ?? outputTokens;

      for (const choice of choices) {
        if (typeof choice !== "object" || choice === null) {
          continue;
        }

        const delta = ((choice as { delta?: unknown }).delta ?? {}) as Record<string, unknown>;
        if (typeof delta.content === "string" && delta.content.length > 0) {
          fullText += delta.content;
          yield {
            type: "text_delta",
            text: delta.content
          };
        }

        const rawToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const rawToolCall of rawToolCalls) {
          if (typeof rawToolCall !== "object" || rawToolCall === null) {
            continue;
          }

          const index = typeof (rawToolCall as { index?: unknown }).index === "number"
            ? (rawToolCall as { index: number }).index
            : 0;
          const current = toolCalls.get(index) ?? {
            id: "",
            name: "",
            argumentsText: ""
          };

          if (typeof (rawToolCall as { id?: unknown }).id === "string") {
            current.id = (rawToolCall as { id: string }).id;
          }

          const fn = ((rawToolCall as { function?: unknown }).function ?? {}) as Record<string, unknown>;
          if (typeof fn.name === "string") {
            current.name = fn.name;
          }
          if (typeof fn.arguments === "string") {
            current.argumentsText += fn.arguments;
          }

          toolCalls.set(index, current);
        }

        if (typeof (choice as { finish_reason?: unknown }).finish_reason === "string") {
          stopReason = String((choice as { finish_reason: string }).finish_reason);
        }
      }
    }

    const content: LlmContentBlock[] = [];
    if (fullText.trim().length > 0) {
      content.push({
        type: "text",
        text: fullText
      });
    }

    for (const call of [...toolCalls.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      if (!call.id || !call.name) {
        continue;
      }
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: parseJsonObject(call.argumentsText)
      });
    }

    yield {
      type: "response.completed",
      response: {
        id: responseId,
        provider: this.config.provider,
        model,
        stopReason,
        usage: {
          inputTokens,
          outputTokens
        },
        content,
        raw: {}
      }
    };
  }
}
