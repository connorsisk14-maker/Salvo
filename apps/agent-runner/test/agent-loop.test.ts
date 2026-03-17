import assert from "node:assert/strict";
import test from "node:test";
import { buildContractV1 } from "@salvo/contracts";
import type { LlmResponse, ToolUseBlock, ToolExecutionOutcome } from "@salvo/llm";
import { runAgentLoop } from "../src/agent-loop";

function buildContract() {
  return buildContractV1({
    contractId: "11111111-1111-4111-8111-111111111111",
    taskId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    request: "Create a markdown report and run validation tests.",
    taskTitle: "Generate report"
  });
}

function completionPayload() {
  return {
    status: "completed" as const,
    summary: "Finished the contract.",
    deliverables: ["run-summary.md"],
    evidence: {
      tests_run: [],
      command_results: [],
      files_changed: 1
    },
    roadblocks: [],
    learnings: []
  };
}

test("runAgentLoop completes after tool execution and accumulates usage", async () => {
  const contract = buildContract();
  const responses: LlmResponse[] = [
    {
      provider: "anthropic",
      model: "claude-sonnet-4",
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 25 },
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "read_file",
          input: { path: "README.md" }
        }
      ],
      raw: {}
    },
    {
      provider: "anthropic",
      model: "claude-sonnet-4",
      stopReason: "tool_use",
      usage: { inputTokens: 120, outputTokens: 20 },
      content: [
        {
          type: "tool_use",
          id: "tool-2",
          name: "salvo_complete",
          input: completionPayload()
        }
      ],
      raw: {}
    }
  ];
  const events: string[] = [];
  const executedTools: string[] = [];

  const result = await runAgentLoop({
    provider: "anthropic",
    model: "claude-sonnet-4",
    systemPrompt: "system",
    userPrompt: "user",
    contract,
    workspaceRoot: "/tmp/workspace",
    createMessage: async () => {
      const next = responses.shift();
      if (!next) {
        throw new Error("Unexpected extra LLM call.");
      }
      return next;
    },
    executeToolUse: async (block): Promise<ToolExecutionOutcome> => {
      executedTools.push(block.name);
      if (block.name === "read_file") {
        return {
          toolResult: {
            type: "tool_result",
            toolUseId: block.id,
            content: JSON.stringify({ ok: true, content: "# Readme" })
          },
          policyDenied: false
        };
      }

      return {
        toolResult: {
          type: "tool_result",
          toolUseId: block.id,
          content: JSON.stringify({ ok: true })
        },
        completionPayload: completionPayload(),
        policyDenied: false
      };
    },
    appendRunEvent: async (eventType) => {
      events.push(eventType);
    }
  });

  assert.equal(result.finalPayload.status, "completed");
  assert.equal(result.exitReason, "salvo_complete");
  assert.deepEqual(executedTools, ["read_file", "salvo_complete"]);
  assert.equal(result.usage.input_tokens, 220);
  assert.equal(result.usage.output_tokens, 45);
  assert.equal(events.filter((event) => event === "usage.reported").length, 2);
});

test("runAgentLoop blocks when the tool call limit is exceeded", async () => {
  const contract = buildContract();
  contract.constraints.max_tool_calls = 1;

  const result = await runAgentLoop({
    provider: "anthropic",
    model: "claude-sonnet-4",
    systemPrompt: "system",
    userPrompt: "user",
    contract,
    workspaceRoot: "/tmp/workspace",
    createMessage: async () => ({
      provider: "anthropic",
      model: "claude-sonnet-4",
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 },
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "read_file",
          input: { path: "README.md" }
        },
        {
          type: "tool_use",
          id: "tool-2",
          name: "write_file",
          input: { path: "run-summary.md", content: "# hi" }
        }
      ],
      raw: {}
    }),
    executeToolUse: async (block) => ({
      toolResult: {
        type: "tool_result",
        toolUseId: block.id,
        content: JSON.stringify({ ok: true })
      },
      policyDenied: false
    }),
    appendRunEvent: async () => {}
  });

  assert.equal(result.finalPayload.status, "blocked");
  assert.equal(result.exitReason, "tool_call_limit");
});

test("runAgentLoop blocks on policy denial when the contract requires it", async () => {
  const contract = buildContract();
  contract.failure_handling.stop_on_policy_denial = true;

  const result = await runAgentLoop({
    provider: "anthropic",
    model: "claude-sonnet-4",
    systemPrompt: "system",
    userPrompt: "user",
    contract,
    workspaceRoot: "/tmp/workspace",
    createMessage: async () => ({
      provider: "anthropic",
      model: "claude-sonnet-4",
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 },
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "write_file",
          input: { path: ".env", content: "SECRET=1" }
        }
      ],
      raw: {}
    }),
    executeToolUse: async (block): Promise<ToolExecutionOutcome> => ({
      toolResult: {
        type: "tool_result",
        toolUseId: block.id,
        content: JSON.stringify({ ok: false }),
        isError: true
      },
      policyDenied: true
    }),
    appendRunEvent: async () => {}
  });

  assert.equal(result.finalPayload.status, "blocked");
  assert.equal(result.exitReason, "policy_denied");
});

test("runAgentLoop blocks after the max_tokens continuation cap is exhausted", async () => {
  const contract = buildContract();
  let calls = 0;

  const result = await runAgentLoop({
    provider: "anthropic",
    model: "claude-sonnet-4",
    systemPrompt: "system",
    userPrompt: "user",
    contract,
    workspaceRoot: "/tmp/workspace",
    createMessage: async () => {
      calls += 1;
      return {
        provider: "anthropic",
        model: "claude-sonnet-4",
        stopReason: "max_tokens",
        usage: { inputTokens: 10, outputTokens: 5 },
        content: [
          {
            type: "text",
            text: "still working"
          }
        ],
        raw: {}
      };
    },
    executeToolUse: async () => {
      throw new Error("Should not execute tools");
    },
    appendRunEvent: async () => {}
  });

  assert.equal(result.finalPayload.status, "blocked");
  assert.equal(result.exitReason, "max_tokens");
  assert.equal(calls, 3);
});

test("runAgentLoop blocks when the runtime budget is exceeded", async () => {
  const contract = buildContract();
  contract.constraints.max_runtime_minutes = 1;
  const timestamps = [0, 61_000];

  const result = await runAgentLoop({
    provider: "anthropic",
    model: "claude-sonnet-4",
    systemPrompt: "system",
    userPrompt: "user",
    contract,
    workspaceRoot: "/tmp/workspace",
    now: () => timestamps.shift() ?? 61_000,
    createMessage: async () => ({
      provider: "anthropic",
      model: "claude-sonnet-4",
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 },
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "read_file",
          input: { path: "README.md" }
        }
      ],
      raw: {}
    }),
    executeToolUse: async (block) => ({
      toolResult: {
        type: "tool_result",
        toolUseId: block.id,
        content: JSON.stringify({ ok: true })
      },
      policyDenied: false
    }),
    appendRunEvent: async () => {}
  });

  assert.equal(result.finalPayload.status, "blocked");
  assert.equal(result.exitReason, "max_runtime");
});

test("runAgentLoop blocks on end_turn without a completion payload", async () => {
  const contract = buildContract();

  const result = await runAgentLoop({
    provider: "anthropic",
    model: "claude-sonnet-4",
    systemPrompt: "system",
    userPrompt: "user",
    contract,
    workspaceRoot: "/tmp/workspace",
    createMessage: async () => ({
      provider: "anthropic",
      model: "claude-sonnet-4",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
      content: [
        {
          type: "text",
          text: "I am done."
        }
      ],
      raw: {}
    }),
    executeToolUse: async () => {
      throw new Error("Should not execute tools");
    },
    appendRunEvent: async () => {}
  });

  assert.equal(result.finalPayload.status, "blocked");
  assert.equal(result.exitReason, "end_turn");
});

test("runAgentLoop can complete from a plain JSON text response", async () => {
  const contract = buildContract();
  const executedBlocks: ToolUseBlock[] = [];

  const result = await runAgentLoop({
    provider: "anthropic",
    model: "claude-sonnet-4",
    systemPrompt: "system",
    userPrompt: "user",
    contract,
    workspaceRoot: "/tmp/workspace",
    createMessage: async () => ({
      provider: "anthropic",
      model: "claude-sonnet-4",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            plan_steps: ["Write summary"],
            summary: "Done.",
            artifacts: [
              {
                path: "run-summary.md",
                content: "# Done"
              }
            ],
            learnings: []
          })
        }
      ],
      raw: {}
    }),
    executeToolUse: async (block): Promise<ToolExecutionOutcome> => {
      executedBlocks.push(block);
      return {
        toolResult: {
          type: "tool_result",
          toolUseId: block.id,
          content: JSON.stringify({ ok: true })
        },
        requiredTestCommandResult:
          block.name === "run_command"
            ? {
                command: String(block.input.command),
                evidence: {
                  command: String(block.input.command),
                  exit_code: 0
                }
              }
            : undefined,
        policyDenied: false
      };
    },
    appendRunEvent: async () => {}
  });

  assert.equal(result.finalPayload.status, "completed");
  assert.equal(result.finalPayload.deliverables[0], "run-summary.md");
  assert.equal(executedBlocks.some((block) => block.name === "write_file"), true);
  assert.equal(executedBlocks.some((block) => block.name === "run_command"), true);
});
