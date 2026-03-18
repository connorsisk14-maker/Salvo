import type { Adapter, AdapterRunRequest, AdapterRunResult } from "./types";
import {
  executeAdapterRunWithReliability,
  FatalAdapterError
} from "./reliability";

type LlmProvider = "anthropic" | "openai" | "custom";

type LlmApiAdapterConfig = {
  provider?: LlmProvider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  headers?: Record<string, string>;
};

const DEFAULT_MODEL_BY_PROVIDER: Record<LlmProvider, string> = {
  anthropic: "claude-3-5-sonnet-latest",
  openai: "gpt-4o",
  custom: "gpt-4o"
};

const DEFAULT_BASE_URL_BY_PROVIDER: Record<LlmProvider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  custom: "https://api.openai.com"
};

function resolveProvider(value: unknown, fallback: LlmProvider): LlmProvider {
  return value === "anthropic" || value === "openai" || value === "custom" ? value : fallback;
}

function buildApiUrl(baseUrl: string, path: string): string {
  const normalized = baseUrl.replace(/\/$/, "");
  if (normalized.endsWith("/v1")) {
    return `${normalized}${path}`;
  }
  return `${normalized}/v1${path}`;
}

export class LlmApiAdapter implements Adapter {
  readonly key = "llm_api";

  constructor(private readonly config: LlmApiAdapterConfig = {}) {}

  private resolveConfig(request: AdapterRunRequest) {
    const payload = request.payload;
    const provider = resolveProvider(payload.provider, this.config.provider ?? "anthropic");
    const apiKey =
      (typeof payload.apiKey === "string" ? payload.apiKey : null) ??
      this.config.apiKey ??
      null;

    if (!apiKey) {
      return null;
    }

    return {
      provider,
      apiKey,
      baseUrl:
        (typeof payload.baseUrl === "string" ? payload.baseUrl : null) ??
        this.config.baseUrl ??
        DEFAULT_BASE_URL_BY_PROVIDER[provider],
      model:
        (typeof payload.model === "string" ? payload.model : null) ??
        this.config.model ??
        DEFAULT_MODEL_BY_PROVIDER[provider],
      maxTokens:
        typeof payload.maxTokens === "number"
          ? payload.maxTokens
          : this.config.maxTokens ?? 1024,
      temperature:
        typeof payload.temperature === "number"
          ? payload.temperature
          : this.config.temperature,
      headers: this.config.headers ?? {}
    };
  }

  async health() {
    if (!this.config.apiKey) {
      return {
        status: "needs_auth" as const,
        detail: "Set LLM API key to unlock hosted model calls."
      };
    }

    return {
      status: "ready" as const,
      detail: "LLM API adapter is authenticated."
    };
  }

  async run(request: AdapterRunRequest): Promise<AdapterRunResult> {
    return executeAdapterRunWithReliability(this.key, async () => {
      const config = this.resolveConfig(request);
      if (!config) {
        throw new FatalAdapterError("LLM API adapter is blocked.");
      }

      const payload = request.payload;
      const systemPrompt =
        typeof payload.systemPrompt === "string" && payload.systemPrompt.trim().length > 0
          ? payload.systemPrompt
          : "You are the Salvo hosted LLM adapter. Answer the request directly and concisely.";
      const userPrompt =
        typeof payload.userPrompt === "string" && payload.userPrompt.trim().length > 0
          ? payload.userPrompt
          : JSON.stringify(payload, null, 2);

      const response = await fetch(
        config.provider === "anthropic"
          ? buildApiUrl(config.baseUrl, "/messages")
          : buildApiUrl(config.baseUrl, "/chat/completions"),
        {
          method: "POST",
          headers:
            config.provider === "anthropic"
              ? {
                  "content-type": "application/json",
                  "x-api-key": config.apiKey,
                  "anthropic-version": "2023-06-01",
                  ...config.headers
                }
              : {
                  "content-type": "application/json",
                  authorization: `Bearer ${config.apiKey}`,
                  ...config.headers
                },
          body: JSON.stringify(
            config.provider === "anthropic"
              ? {
                  model: config.model,
                  max_tokens: config.maxTokens,
                  temperature: config.temperature,
                  system: systemPrompt,
                  messages: [{ role: "user", content: userPrompt }]
                }
              : {
                  model: config.model,
                  max_tokens: config.maxTokens,
                  temperature: config.temperature,
                  messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                  ]
                }
          )
        }
      );

      if (!response.ok) {
        throw new Error(`LLM API request failed (${response.status}): ${await response.text()}`);
      }

      const raw = (await response.json()) as Record<string, unknown>;
      const usage =
        config.provider === "anthropic"
          ? {
              inputTokens:
                typeof (raw.usage as { input_tokens?: unknown } | undefined)?.input_tokens === "number"
                  ? ((raw.usage as { input_tokens: number }).input_tokens)
                  : 0,
              outputTokens:
                typeof (raw.usage as { output_tokens?: unknown } | undefined)?.output_tokens === "number"
                  ? ((raw.usage as { output_tokens: number }).output_tokens)
                  : 0
            }
          : {
              inputTokens:
                typeof (raw.usage as { prompt_tokens?: unknown } | undefined)?.prompt_tokens === "number"
                  ? ((raw.usage as { prompt_tokens: number }).prompt_tokens)
                  : 0,
              outputTokens:
                typeof (raw.usage as { completion_tokens?: unknown } | undefined)?.completion_tokens === "number"
                  ? ((raw.usage as { completion_tokens: number }).completion_tokens)
                  : 0
            };

      const content =
        config.provider === "anthropic"
          ? raw.content
          : ((raw.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message?.content ?? "");

      return {
        ok: true,
        detail: `LLM response received for ${request.runId}.`,
        output: {
          adapter: this.key,
          provider: config.provider,
          model: typeof raw.model === "string" ? raw.model : config.model,
          stopReason:
            config.provider === "anthropic"
              ? (typeof raw.stop_reason === "string" ? raw.stop_reason : null)
              : (typeof (raw.choices as Array<{ finish_reason?: unknown }> | undefined)?.[0]?.finish_reason === "string"
                  ? ((raw.choices as Array<{ finish_reason: string }>)[0].finish_reason)
                  : null),
          usage,
          content,
          raw
        }
      };
    });
  }
}
