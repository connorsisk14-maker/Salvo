import type { Adapter, AdapterRunRequest, AdapterRunResult } from "./types";

export class ClaudeLocalAdapter implements Adapter {
  readonly key = "claude_local";

  constructor(private readonly authToken?: string) {}

  async health() {
    if (!this.authToken) {
      return {
        status: "needs_auth" as const,
        detail: "Set CLAUDE_LOCAL_AUTH_TOKEN to unlock local Claude calls."
      };
    }

    return {
      status: "ready" as const,
      detail: "Claude local adapter scaffold is authenticated."
    };
  }

  async run(request: AdapterRunRequest): Promise<AdapterRunResult> {
    const health = await this.health();
    if (health.status !== "ready") {
      return {
        ok: false,
        detail: health.detail ?? "Claude local adapter is blocked."
      };
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
  }
}
