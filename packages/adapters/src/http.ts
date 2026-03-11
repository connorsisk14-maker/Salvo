import type { Adapter, AdapterRunRequest, AdapterRunResult } from "./types";

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
    const health = await this.health();
    if (health.status !== "ready") {
      return {
        ok: false,
        detail: health.detail ?? "HTTP adapter is blocked."
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/runs`, {
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

      if (!response.ok) {
        return {
          ok: false,
          detail: `HTTP adapter request failed with ${response.status}.`
        };
      }

      return {
        ok: true,
        detail: `HTTP adapter run ${request.runId} completed.`,
        output: await response.json()
      };
    } catch (error) {
      return {
        ok: false,
        detail: `HTTP adapter request failed: ${(error as Error).message}`
      };
    }
  }
}
