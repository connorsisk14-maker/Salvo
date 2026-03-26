import assert from "node:assert/strict";
import { test } from "node:test";
import { ResearchAnalysisService } from "../src/service";

test("publishLoop uses synthesized research memory when llm config is available", async () => {
  const originalFetch = globalThis.fetch;
  const published: Array<Record<string, unknown>> = [];

  const fakeRepo = {
    listAcceptedUnpublishedResearchExperiments: async () => [
      {
        id: "experiment-1",
        workspace_id: "workspace-1",
        contract_family_key: "family-1",
        contract_category: "quality",
        contract_subcategory: "testing",
        sample_size: 15,
        source_digest: "digest-1",
        source_run_ids: ["run-1", "run-2"],
        metrics_json: {},
        body_markdown: "# Experiment\n\nObserved a stable pass rate.",
        confidence: 0.87,
        review_status: "accepted" as const,
        published_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ],
    listIntegrationConfigs: async () => [
      {
        integration_key: "llm_api",
        config_json: {
          provider: "anthropic",
          apiKey: "test-key",
          baseUrl: "http://127.0.0.1:9999",
          defaultModel: "claude-3-5-sonnet"
        }
      }
    ],
    listResearchContext: async () => [
      {
        id: "doc-1",
        source_run_ids: ["run-1"],
        confidence: 0.9,
        review_status: "accepted" as const
      }
    ],
    listMemoryContext: async () => [
      {
        id: "memory-1",
        confidence: 0.8,
        review_status: "accepted" as const
      }
    ],
    publishAcceptedResearchExperiment: async (_experimentId: string, memoryOverride?: Record<string, unknown>) => {
      published.push(memoryOverride ?? {});
      return true;
    }
  } as const;

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "msg-1",
        model: "claude-3-5-sonnet",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 40
        },
        content: [
          {
            type: "text",
            text: JSON.stringify({
              title: "Research memory: quality/testing",
              summary: "Stable pass rate observed across the experiment sample.",
              body_markdown: "# Memory\n\nStable pass rate observed across the experiment sample.",
              tags: ["research", "memory", "quality", "testing"],
              confidence: 0.91
            })
          }
        ]
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    )) as typeof fetch;

  try {
    const service = new ResearchAnalysisService(fakeRepo as never, 15);
    const result = await service.publishLoop();

    assert.equal(result, 1);
    assert.equal(published.length, 1);
    assert.equal(published[0]?.title, "Research memory: quality/testing");
    assert.equal(published[0]?.summary, "Stable pass rate observed across the experiment sample.");
    assert.deepEqual(published[0]?.tags, ["research", "memory", "quality", "testing"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
