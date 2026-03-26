import assert from "node:assert/strict";
import test from "node:test";
import type { SkillExecutionContext } from "../src/types";
import { webSearchExtractSkill } from "../src/builtin/web-search-extract";

class MockFetcher {
  capturedRequest:
    | {
        path?: string;
        url?: string;
        query?: Record<string, string | number | boolean | undefined>;
      }
    | undefined;

  constructor(private readonly surface: Record<string, unknown>) {}

  async request(input: {
    path?: string;
    url?: string;
    query?: Record<string, string | number | boolean | undefined>;
  }) {
    this.capturedRequest = input;
    return {
      ok: true,
      status: 200,
      json: async () => this.surface,
      text: async () => JSON.stringify(this.surface)
    };
  }
}

test("web_search_extract returns structured results and dedupes", async () => {
  const fetcher = new MockFetcher({
    businesses: [
      { name: "Acme Corp", address: "100 Main St", website: "https://acme.com", services: ["HVAC"], rating: 4.7, source: "serp" },
      { name: "Acme Corp", address: "100 Main St", website: "https://acme.com/ops", services: ["HVAC"] },
      { name: "Delta" , address: "200 Market" , rating: 4 }
    ]
  });
  const result = await webSearchExtractSkill.execute({
    query: "hvac dallas",
    limit: 2
  }, {
    workspacePath: "/tmp",
    runId: "web-search-1",
    adapters: {
      http: fetcher
    },
    repo: {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.output.query, "hvac dallas");
  assert.equal(result.output.results.length, 2);
  assert.equal(result.output.deduped, 2);
  assert(result.output.results.every((entry) => entry.name.length > 0));
  assert.deepEqual(fetcher.capturedRequest, {
    path: "/api/business",
    query: {
      q: "hvac dallas",
      loc: "dfw",
      limit: 2
    }
  });
});

test("web_search_extract handles fetch failures", async () => {
  const context: SkillExecutionContext = {
    workspacePath: "/tmp",
    runId: "web-search-2",
    adapters: {
      http: {
        async request() {
          return {
            ok: false,
            status: 429,
            json: async () => ({}),
            text: async () => "rate limited"
          };
        }
      }
    },
    repo: {}
  };
  const result = await webSearchExtractSkill.execute({ query: "lead" }, context);
  assert.equal(result.ok, false);
  assert.equal(result.output.results.length, 0);
  assert.equal(result.events.length, 1);
});
