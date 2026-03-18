import type { Adapter, AdapterRunRequest, AdapterRunResult } from "./types";
import {
  executeAdapterRunWithReliability,
  FatalAdapterError,
  RetryableAdapterError
} from "./reliability";

export class HttpAdapter implements Adapter {
  readonly key = "http";

  constructor(
    private readonly baseUrl = "",
    private readonly token?: string
  ) {}

  async health() {
    if (!this.baseUrl) {
      return {
        status: "not_configured" as const,
        detail: "Set a base URL to use HTTP adapter workflows."
      };
    }

    if (!this.token) {
      return {
        status: "needs_auth" as const,
        detail: "Provide HTTP adapter token for authenticated requests."
      };
    }

    return {
      status: "ready" as const,
      detail: "HTTP adapter scaffold is configured."
    };
  }

  async run(request: AdapterRunRequest): Promise<AdapterRunResult> {
    return executeAdapterRunWithReliability(this.key, async () => {
      const health = await this.health();
      if (health.status !== "ready") {
        throw new FatalAdapterError(health.detail ?? "HTTP adapter is blocked.");
      }

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/runs`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`
          },
          body: JSON.stringify({
            runId: request.runId,
            payload: request.payload
          })
        });
      } catch (error) {
        throw new RetryableAdapterError(
          `HTTP adapter request failed: ${(error as Error).message}`
        );
      }

      if (!response.ok) {
        const detail = `HTTP adapter request failed with ${response.status}.`;
        if (response.status >= 500) {
          throw new RetryableAdapterError(detail);
        }
        return {
          ok: false,
          detail
        };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new RetryableAdapterError(
          `HTTP adapter response parsing failed: ${(error as Error).message}`
        );
      }

      return {
        ok: true,
        detail: `HTTP adapter run ${request.runId} completed.`,
        output: payload
      };
    });
  }
}
