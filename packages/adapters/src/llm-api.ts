import type { Adapter, AdapterRunRequest, AdapterRunResult } from "./types";
import {
  executeAdapterRunWithReliability,
  FatalAdapterError
} from "./reliability";

export class LlmApiAdapter implements Adapter {
  readonly key = "llm_api";

  constructor(private readonly apiKey?: string) {}

  async health() {
    if (!this.apiKey) {
      return {
        status: "needs_auth" as const,
        detail: "Set LLM API key to unlock hosted model calls."
      };
    }

    return {
      status: "ready" as const,
      detail: "LLM API adapter scaffold is authenticated."
    };
  }

  async run(request: AdapterRunRequest): Promise<AdapterRunResult> {
    return executeAdapterRunWithReliability(this.key, async () => {
      const health = await this.health();
      if (health.status !== "ready") {
        throw new FatalAdapterError(health.detail ?? "LLM API adapter is blocked.");
      }

      return {
        ok: true,
        detail: `Scaffold run executed for ${request.runId}.`,
        output: {
          adapter: this.key,
          accepted: true,
          payload: request.payload
        }
      };
    });
  }
}
