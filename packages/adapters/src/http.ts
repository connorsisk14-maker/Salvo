import type { Adapter, AdapterRunRequest, AdapterRunResult } from "./types";
import {
  executeAdapterRunWithReliability,
  FatalAdapterError,
  RetryableAdapterError
} from "./reliability";

export type HttpAdapterRequest = {
  path?: string;
  url?: string;
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  body?:
    | string
    | URLSearchParams
    | FormData
    | Blob
    | ArrayBuffer
    | ArrayBufferView
    | Record<string, unknown>
    | unknown[];
};

export class HttpAdapter implements Adapter {
  readonly key = "http";

  constructor(
    readonly baseUrl = "",
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async request(input: HttpAdapterRequest): Promise<Response> {
    const url = this.resolveUrl(input);
    const headers = new Headers(input.headers);

    if (this.token && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${this.token}`);
    }

    let body:
      | string
      | URLSearchParams
      | FormData
      | Blob
      | ArrayBuffer
      | ArrayBufferView
      | undefined;
    if (typeof input.body === "string" || input.body instanceof URLSearchParams || input.body instanceof FormData || input.body instanceof Blob) {
      body = input.body;
    } else if (input.body instanceof ArrayBuffer || ArrayBuffer.isView(input.body)) {
      body = input.body;
    } else if (input.body !== undefined) {
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      body = JSON.stringify(input.body);
    }

    return this.fetchImpl(url, {
      method: input.method ?? "GET",
      headers,
      body: body as RequestInit["body"]
    });
  }

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
        response = await this.request({
          path: "/runs",
          method: "POST",
          body: {
            runId: request.runId,
            payload: request.payload
          }
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

  private resolveUrl(input: HttpAdapterRequest): string {
    if (typeof input.url === "string" && input.url.trim().length > 0) {
      return this.appendQuery(input.url.trim(), input.query);
    }

    if (!this.baseUrl) {
      throw new Error("HTTP adapter base URL is not configured.");
    }

    const baseUrl = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
    const path = input.path?.trim().replace(/^\/+/, "") ?? "";
    return this.appendQuery(new URL(path, baseUrl).toString(), input.query);
  }

  private appendQuery(rawUrl: string, query: HttpAdapterRequest["query"]): string {
    if (!query || Object.keys(query).length === 0) {
      return rawUrl;
    }

    const url = new URL(rawUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}
