import assert from "node:assert/strict";
import test from "node:test";
import { LlmApiAdapter } from "../src/llm-api";

test("LlmApiAdapter calls the shared LLM client and returns structured output", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody = "";

  globalThis.fetch = (async (url, init) => {
    capturedUrl = String(url);
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        id: "msg_1",
        model: "claude-3-5-sonnet-latest",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 22,
          output_tokens: 7
        },
        content: [
          {
            type: "text",
            text: "{\"summary\":\"ok\"}"
          }
        ]
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  }) as typeof fetch;

  try {
    const adapter = new LlmApiAdapter({
      provider: "anthropic",
      apiKey: "test-key"
    });

    const result = await adapter.run({
      runId: "run-1",
      payload: {
        userPrompt: "Summarize the task."
      }
    });

    assert.equal(result.ok, true);
    assert.equal(capturedUrl, "https://api.anthropic.com/v1/messages");
    assert.equal(JSON.parse(capturedBody).messages[0].content, "Summarize the task.");
    assert.deepEqual(result.output, {
      adapter: "llm_api",
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      stopReason: "end_turn",
      usage: {
        inputTokens: 22,
        outputTokens: 7
      },
      content: [
        {
          type: "text",
          text: "{\"summary\":\"ok\"}"
        }
      ],
      raw: {
        id: "msg_1",
        model: "claude-3-5-sonnet-latest",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 22,
          output_tokens: 7
        },
        content: [
          {
            type: "text",
            text: "{\"summary\":\"ok\"}"
          }
        ]
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LlmApiAdapter reports needs_auth without a configured API key", async () => {
  const adapter = new LlmApiAdapter();
  const health = await adapter.health();
  assert.equal(health.status, "needs_auth");
});
