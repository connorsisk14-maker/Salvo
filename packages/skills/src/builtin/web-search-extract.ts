import type { Skill, SkillArtifact, SkillEvent, SkillExecutionContext } from "../types";

type SearchResult = {
  name: string;
  address: string;
  website?: string;
  services?: string[];
  rating?: number;
  source?: string;
};

type WebSearchExtractInput = {
  query: string;
  location?: string;
  limit?: number;
};

type WebSearchExtractOutput = {
  query: string;
  location: string;
  results: SearchResult[];
  deduped: number;
  artifactPath?: string;
};

type HttpFetcher = {
  baseUrl?: string;
  request?(input: {
    path?: string;
    url?: string;
    query?: Record<string, string | number | boolean | undefined>;
  }): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
  fetch?(
    url: string,
    init?: RequestInit
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
};

const SEARCH_PATH = "/api/business";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveFetcher(context: SkillExecutionContext): HttpFetcher {
  const candidate = ((context.adapters ?? {}) as Record<string, unknown>).http;
  if (!candidate) {
    throw new Error("http adapter not configured");
  }
  const fetcher = candidate as HttpFetcher;
  if (typeof fetcher.request !== "function" && typeof fetcher.fetch !== "function") {
    throw new Error("http adapter not configured");
  }
  return fetcher;
}

function buildUrl(baseUrl: string, query: string, location: string, limit: number): string {
  const url = new URL(
    SEARCH_PATH.replace(/^\/+/, ""),
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  );
  url.searchParams.set("q", query);
  url.searchParams.set("loc", location);
  url.searchParams.set("limit", limit.toString());
  return url.toString();
}

function normalizeResult(source: unknown): SearchResult | null {
  if (!source || typeof source !== "object") {
    return null;
  }
  const entry = source as Record<string, unknown>;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  const address = typeof entry.address === "string" ? entry.address.trim() : "";
  if (!name || !address) {
    return null;
  }
  return {
    name,
    address,
    website: typeof entry.website === "string" ? entry.website.trim() || undefined : undefined,
    services: Array.isArray(entry.services)
      ? entry.services.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : undefined,
    rating: typeof entry.rating === "number" ? entry.rating : undefined,
    source: typeof entry.source === "string" ? entry.source.trim() : undefined
  };
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const filtered: SearchResult[] = [];
  for (const result of results) {
    const key = `${result.name.toLowerCase()}|${result.address.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    filtered.push(result);
  }
  return filtered;
}

export const webSearchExtractSkill: Skill<WebSearchExtractInput, WebSearchExtractOutput> = {
  name: "web_search_extract",
  version: "1.0.0",
  description: "Search the web for DFW businesses and return structured lead data.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1 },
      location: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 50 }
    },
    additionalProperties: false
  },
  async execute(input, context) {
    const location = input.location?.trim() || "dfw";
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.min(Math.max(Math.floor(input.limit), 1), 50)
        : 10;
    const fetcher = resolveFetcher(context);
    const query = input.query.trim();
    const requestUrl =
      typeof fetcher.baseUrl === "string" && fetcher.baseUrl.trim().length > 0
        ? buildUrl(fetcher.baseUrl.trim(), query, location, limit)
        : SEARCH_PATH;

    const resultEvents: SkillEvent[] = [];
    let results: SearchResult[] = [];

    try {
      const response =
        typeof fetcher.request === "function"
          ? await fetcher.request({
              path: SEARCH_PATH,
              query: {
                q: query,
                loc: location,
                limit
              }
            })
          : await fetcher.fetch!(requestUrl);
      if (!response.ok) {
        resultEvents.push({
          type: "web_search_extract.rate_limit",
          level: "warn",
          payload: { status: response.status, url: requestUrl }
        });
        return {
          ok: false,
          output: {
            query: input.query,
            location,
            results: [],
            deduped: 0
          },
          artifacts: [],
          events: resultEvents
        };
      }

      const payload = await response.json();
      const raw = isRecord(payload) && Array.isArray(payload.businesses) ? payload.businesses : [];
      const normalized = raw
        .map(normalizeResult)
        .filter((entry: SearchResult | null): entry is SearchResult => entry !== null);
      results = dedupeResults(normalized).slice(0, limit);
    } catch (error) {
      resultEvents.push({
        type: "web_search_extract.failure",
        level: "error",
        payload: { message: (error as Error).message, url: requestUrl }
      });
      return {
        ok: false,
        output: {
          query: input.query,
          location,
          results: [],
          deduped: 0
        },
        artifacts: [],
        events: resultEvents
      };
    }

    const artifact: SkillArtifact = {
      path: `web-search-${context.runId}.json`,
      artifactType: "json",
      metadata: {
        query: input.query,
        returned: results.length
      }
    };

    resultEvents.push({
      type: "web_search_extract.success",
      level: "info",
      payload: {
        query: input.query,
        location,
        returned: results.length
      }
    });

    return {
      ok: true,
      output: {
        query: input.query,
        location,
        results,
        deduped: results.length
      },
      artifacts: [artifact],
      events: resultEvents
    };
  }
};
