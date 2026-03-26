import assert from "node:assert/strict";
import test from "node:test";
import {
  LlmAuthError,
  LlmClient,
  LlmRateLimitError,
  LlmServerError,
  type LlmConfig,
  type LlmStreamChunk
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

async function collectChunks(stream: AsyncGenerator<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const chunks: LlmStreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
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

test("LlmClient.createMessage sends OpenAI-compatible tool calls and parses tool responses", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  const client = new LlmClient(
    createConfig({
      provider: "openai",
      baseUrl: "https://api.openai.com",
      model: "gpt-4o"
    }),
    (async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          id: "chatcmpl_123",
          model: "gpt-4o",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "Inspecting files",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: "{\"path\":\"README.md\"}"
                    }
                  }
                ]
              }
            }
          ],
          usage: {
            prompt_tokens: 80,
            completion_tokens: 12
          }
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
    "System",
    [
      {
        role: "user",
        content: "Read the readme"
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "prior_call",
            name: "list_directory",
            input: { path: "." }
          }
        ]
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolUseId: "prior_call",
            content: "{\"ok\":true}"
          }
        ]
      }
    ],
    [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"]
        }
      }
    ]
  );

  assert.equal(capturedUrl, "https://api.openai.com/v1/chat/completions");
  const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.deepEqual(body.tools, [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"]
        }
      }
    }
  ]);
  assert.deepEqual(body.messages, [
    { role: "system", content: "System" },
    { role: "user", content: "Read the readme" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "prior_call",
          type: "function",
          function: {
            name: "list_directory",
            arguments: "{\"path\":\".\"}"
          }
        }
      ]
    },
    {
      role: "tool",
      tool_call_id: "prior_call",
      content: "{\"ok\":true}"
    }
  ]);

  assert.equal(response.provider, "openai");
  assert.equal(response.stopReason, "tool_calls");
  assert.deepEqual(response.content, [
    {
      type: "text",
      text: "Inspecting files"
    },
    {
      type: "tool_use",
      id: "call_1",
      name: "read_file",
      input: {
        path: "README.md"
      }
    }
  ]);
});

test("LlmClient.streamMessage yields streamed Anthropic deltas and final response", async () => {
  const client = new LlmClient(
    createConfig(),
    (async () =>
      new Response(
        [
          "event: message_start\n",
          "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-3-5-sonnet-latest\",\"usage\":{\"input_tokens\":10}}}\n\n",
          "event: content_block_start\n",
          "data: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
          "event: content_block_delta\n",
          "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
          "event: content_block_delta\n",
          "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\" world\"}}\n\n",
          "event: message_delta\n",
          "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":4}}\n\n"
        ].join(""),
        { status: 200 }
      )) as typeof fetch
  );

  const chunks = await collectChunks(
    client.streamMessage("System", [{ role: "user", content: "hello" }])
  );

  assert.deepEqual(chunks.slice(0, 3), [
    {
      type: "response.started",
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      responseId: "msg_1"
    },
    {
      type: "text_delta",
      text: "Hello"
    },
    {
      type: "text_delta",
      text: " world"
    }
  ]);

  const completed = chunks.at(-1);
  assert.equal(completed?.type, "response.completed");
  assert.deepEqual(
    completed?.type === "response.completed" ? completed.response.content : null,
    [{ type: "text", text: "Hello world" }]
  );
});

test("LlmClient.streamMessage yields streamed OpenAI deltas and tool calls", async () => {
  const client = new LlmClient(
    createConfig({
      provider: "custom",
      baseUrl: "https://llm.example.com/v1",
      model: "gpt-4o-mini"
    }),
    (async () =>
      new Response(
        [
          "data: {\"id\":\"chatcmpl_stream\",\"model\":\"gpt-4o-mini\",\"choices\":[{\"delta\":{\"content\":\"Plan: \"}}]}\n\n",
          "data: {\"id\":\"chatcmpl_stream\",\"model\":\"gpt-4o-mini\",\"choices\":[{\"delta\":{\"content\":\"read file\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"REA\"}}]}}]}\n\n",
          "data: {\"id\":\"chatcmpl_stream\",\"model\":\"gpt-4o-mini\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"DME.md\\\"}\"}}],\"finish_reason\":\"tool_calls\"}}],\"usage\":{\"prompt_tokens\":33,\"completion_tokens\":8}}\n\n",
          "data: [DONE]\n\n"
        ].join(""),
        { status: 200 }
      )) as typeof fetch
  );

  const chunks = await collectChunks(
    client.streamMessage("System", [{ role: "user", content: "hello" }], [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" }
          }
        }
      }
    ])
  );

  assert.deepEqual(chunks.slice(0, 3), [
    {
      type: "response.started",
      provider: "custom",
      model: "gpt-4o-mini",
      responseId: "chatcmpl_stream"
    },
    {
      type: "text_delta",
      text: "Plan: "
    },
    {
      type: "text_delta",
      text: "read file"
    }
  ]);

  const completed = chunks.at(-1);
  assert.equal(completed?.type, "response.completed");
  assert.deepEqual(
    completed?.type === "response.completed" ? completed.response.content : null,
    [
      {
        type: "text",
        text: "Plan: read file"
      },
      {
        type: "tool_use",
        id: "call_1",
        name: "read_file",
        input: {
          path: "README.md"
        }
      }
    ]
  );
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
