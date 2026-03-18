import assert from "node:assert/strict";
import test from "node:test";
import {
  LlmAuthError,
  LlmClient,
  LlmRateLimitError,
  LlmServerError,
  type LlmConfig
} from "../src/index";

function createConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "anthropic",
    apiKey: "test-key",
    baseUrl: "https://api.anthropic.com",
    model: "claude-3-5-sonnet-latest",
    maxTokens: 1800,
    temperature: 0.2,
    ...overrides
  };
}

test("LlmClient.createMessage sends Anthropic headers and request shape", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  const client = new LlmClient(
    createConfig(),
    (async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;

      return new Response(
        JSON.stringify({
          id: "msg_123",
          model: "claude-3-5-sonnet-latest",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 120,
            output_tokens: 40
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
    }) as typeof fetch
  );

  const response = await client.createMessage(
    "You are a system.",
    [
      {
        role: "user",
        content: "Solve the task."
      }
    ],
    [
      {
        name: "read_file",
        description: "Read a file from disk",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" }
          }
        }
      }
    ]
  );

  assert.equal(capturedUrl, "https://api.anthropic.com/v1/messages");
  assert.ok(capturedInit);
  assert.equal(capturedInit.method, "POST");

  const headers = capturedInit.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["x-api-key"], "test-key");
  assert.equal(headers["anthropic-version"], "2023-06-01");

  const body = JSON.parse(String(capturedInit.body)) as Record<string, unknown>;
  assert.equal(body.model, "claude-3-5-sonnet-latest");
  assert.equal(body.max_tokens, 1800);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.system, "You are a system.");
  assert.deepEqual(body.messages, [
    {
      role: "user",
      content: "Solve the task."
    }
  ]);
  assert.deepEqual(body.tools, [
    {
      name: "read_file",
      description: "Read a file from disk",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" }
        }
      }
    }
  ]);

  assert.equal(response.provider, "anthropic");
  assert.equal(response.model, "claude-3-5-sonnet-latest");
  assert.equal(response.usage.inputTokens, 120);
  assert.equal(response.usage.outputTokens, 40);
  assert.deepEqual(response.content, [
    {
      type: "text",
      text: "{\"summary\":\"ok\"}"
    }
  ]);
});

test("LlmClient.createMessage throws typed HTTP errors", async () => {
  const authClient = new LlmClient(
    createConfig(),
    (async () => new Response("bad auth", { status: 401 })) as typeof fetch
  );
  await assert.rejects(
    authClient.createMessage("system", [{ role: "user", content: "hello" }]),
    (error: unknown) =>
      error instanceof LlmAuthError &&
      error.status === 401 &&
      error.body === "bad auth"
  );

  const rateLimitClient = new LlmClient(
    createConfig(),
    (async () => new Response("slow down", { status: 429 })) as typeof fetch
  );
  await assert.rejects(
    rateLimitClient.createMessage("system", [{ role: "user", content: "hello" }]),
    (error: unknown) =>
      error instanceof LlmRateLimitError &&
      error.status === 429 &&
      error.body === "slow down"
  );

  const serverClient = new LlmClient(
    createConfig(),
    (async () => new Response("upstream failure", { status: 503 })) as typeof fetch
  );
  await assert.rejects(
    serverClient.createMessage("system", [{ role: "user", content: "hello" }]),
    (error: unknown) =>
      error instanceof LlmServerError &&
      error.status === 503 &&
      error.body === "upstream failure"
  );
});
