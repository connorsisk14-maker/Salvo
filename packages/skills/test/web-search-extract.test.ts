import assert from "node:assert/strict";
import test from "node:test";
import type { SkillExecutionContext } from "../src/types";
import { webSearchExtractSkill } from "../src/builtin/web-search-extract";

class MockFetcher {
  constructor(private readonly surface: Record<string, unknown>) {}

  async fetch(url: string) {
    return {
      ok: true,
      status: 200,
      json: async () => this.surface,
      text: async () => JSON.stringify(this.surface)
    };
  }
}

function createContext(surface: Record<string, unknown>): SkillExecutionContext {
  return {
    workspacePath: "/tmp",
    runId: "web-search-1",
    adapters: {
      http: new MockFetcher(surface)
    },
    repo: {}
  };
}

test("web_search_extract returns structured results and dedupes", async () => {
  const surface = {
    businesses: [
      { name: "Acme Corp", address: "100 Main St", website: "https://acme.com", services: ["HVAC"], rating: 4.7, source: "serp" },
      { name: "Acme Corp", address: "100 Main St", website: "https://acme.com/ops", services: ["HVAC"] },
      { name: "Delta" , address: "200 Market" , rating: 4 }
    ]
  };
  const result = await webSearchExtractSkill.execute({ query: "hvac dallas", limit: 2 }, createContext(surface));
  assert.equal(result.ok, true);
  assert.equal(result.output.query, "hvac dallas");
  assert.equal(result.output.results.length, 2);
  assert.equal(result.output.deduped, 2);
  assert(result.output.results.every((entry) => entry.name.length > 0));
});

test("web_search_extract handles fetch failures", async () => {
  const context: SkillExecutionContext = {
    workspacePath: "/tmp",
    runId: "web-search-2",
    adapters: {
      http: {
        async fetch() {
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
