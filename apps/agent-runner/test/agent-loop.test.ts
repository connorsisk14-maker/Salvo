import assert from "node:assert/strict";
import test from "node:test";
import { buildContractV1 } from "@salvo/contracts";
import type { LlmResponse, ToolUseBlock, ToolExecutionOutcome } from "@salvo/llm";
import { runAgentLoop, type AgentLoopCheckpointState } from "../src/agent-loop";

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

test("runAgentLoop executes multiple tool calls from a single assistant turn", async () => {
  const contract = buildContract();
  const executedTools: string[] = [];

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
      usage: { inputTokens: 20, outputTokens: 10 },
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
          name: "salvo_complete",
          input: completionPayload()
        }
      ],
      raw: {}
    }),
    executeToolUse: async (block): Promise<ToolExecutionOutcome> => {
      executedTools.push(block.name);
      return {
        toolResult: {
          type: "tool_result",
          toolUseId: block.id,
          content: JSON.stringify({ ok: true })
        },
        completionPayload: block.name === "salvo_complete" ? completionPayload() : undefined,
        policyDenied: false
      };
    },
    appendRunEvent: async () => {}
  });

  assert.equal(result.finalPayload.status, "completed");
  assert.deepEqual(executedTools, ["read_file", "salvo_complete"]);
});

test("runAgentLoop generates a plan and emits per-step events before completion", async () => {
  const contract = buildContract();
  const responses: LlmResponse[] = [
    {
      provider: "openai",
      model: "gpt-4o",
      stopReason: "end_turn",
      usage: { inputTokens: 40, outputTokens: 20 },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            summary: "Plan the run.",
            steps: [
              {
                id: "step-1",
                title: "Inspect the workspace",
                expected_inputs: ["README.md"],
                expected_outputs: ["workspace notes"]
              },
              {
                id: "step-2",
                title: "Finish the run",
                expected_inputs: ["workspace notes"],
                expected_outputs: ["run-summary.md"]
              }
            ]
          })
        }
      ],
      raw: {}
    },
    {
      provider: "openai",
      model: "gpt-4o",
      stopReason: "tool_calls",
      usage: { inputTokens: 25, outputTokens: 10 },
      content: [
        {
          type: "tool_use",
          id: "complete-step-1",
          name: "plan_step_complete",
          input: {
            step_id: "step-1",
            summary: "Inspected the workspace.",
            outputs: ["workspace notes"]
          }
        }
      ],
      raw: {}
    },
    {
      provider: "openai",
      model: "gpt-4o",
      stopReason: "tool_calls",
      usage: { inputTokens: 30, outputTokens: 12 },
      content: [
        {
          type: "tool_use",
          id: "complete-step-2",
          name: "plan_step_complete",
          input: {
            step_id: "step-2",
            summary: "Prepared the final payload.",
            outputs: ["run-summary.md"]
          }
        },
        {
          type: "tool_use",
          id: "tool-complete",
          name: "salvo_complete",
          input: completionPayload()
        }
      ],
      raw: {}
    }
  ];
  const events: string[] = [];

  const result = await runAgentLoop({
    provider: "openai",
    model: "gpt-4o",
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
    executeToolUse: async (block): Promise<ToolExecutionOutcome> => ({
      toolResult: {
        type: "tool_result",
        toolUseId: block.id,
        content: JSON.stringify({ ok: true })
      },
      completionPayload: block.name === "salvo_complete" ? completionPayload() : undefined,
      policyDenied: false
    }),
    appendRunEvent: async (eventType) => {
      events.push(eventType);
    }
  });

  assert.equal(result.finalPayload.status, "completed");
  assert.deepEqual(events.filter((event) => event === "plan.generated"), ["plan.generated"]);
  assert.deepEqual(events.filter((event) => event === "plan.step.started"), [
    "plan.step.started",
    "plan.step.started"
  ]);
  assert.deepEqual(events.filter((event) => event === "plan.step.completed"), [
    "plan.step.completed",
    "plan.step.completed"
  ]);
});

test("runAgentLoop blocks completion before the active plan step is complete", async () => {
  const contract = buildContract();
  const responses: LlmResponse[] = [
    {
      provider: "anthropic",
      model: "claude-sonnet-4",
      stopReason: "end_turn",
      usage: { inputTokens: 20, outputTokens: 10 },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            summary: "Plan the run.",
            steps: [
              {
                id: "step-1",
                title: "Inspect the workspace",
                expected_inputs: ["README.md"],
                expected_outputs: ["workspace notes"]
              }
            ]
          })
        }
      ],
      raw: {}
    },
    {
      provider: "anthropic",
      model: "claude-sonnet-4",
      stopReason: "tool_use",
      usage: { inputTokens: 20, outputTokens: 5 },
      content: [
        {
          type: "tool_use",
          id: "tool-complete",
          name: "salvo_complete",
          input: completionPayload()
        }
      ],
      raw: {}
    }
  ];
  const events: string[] = [];

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
    executeToolUse: async () => {
      throw new Error("Completion tool should not execute before plan completion.");
    },
    appendRunEvent: async (eventType) => {
      events.push(eventType);
    }
  });

  assert.equal(result.finalPayload.status, "blocked");
  assert.equal(result.exitReason, "plan_deviation");
  assert.equal(events.includes("plan.deviation_detected"), true);
});

test("runAgentLoop resumes from a saved partial tool batch checkpoint", async () => {
  const contract = buildContract();
  const executedTools: string[] = [];
  let savedCheckpoint: AgentLoopCheckpointState | null = null;

  const result = await runAgentLoop({
    provider: "anthropic",
    model: "claude-sonnet-4",
    systemPrompt: "system",
    userPrompt: "user",
    contract,
    workspaceRoot: "/tmp/workspace",
    createMessage: async () => {
      throw new Error("LLM should not be called when resuming pending tool work.");
    },
    executeToolUse: async (block): Promise<ToolExecutionOutcome> => {
      executedTools.push(block.name);
      if (block.name === "salvo_complete") {
        return {
          toolResult: {
            type: "tool_result",
            toolUseId: block.id,
            content: JSON.stringify({ ok: true })
          },
          completionPayload: completionPayload(),
          policyDenied: false
        };
      }

      return {
        toolResult: {
          type: "tool_result",
          toolUseId: block.id,
          content: JSON.stringify({ ok: true })
        },
        policyDenied: false
      };
    },
    appendRunEvent: async () => {},
    loadCheckpoint: async () => ({
      schemaVersion: 1,
      messages: [
        {
          role: "user",
          content: "user"
        }
      ],
      usage: {
        provider: "anthropic",
        model: "claude-sonnet-4",
        input_tokens: 100,
        output_tokens: 25,
        cost_usd: 0.000675,
        estimated: false,
        pricing_unit: "usd_per_1m_tokens"
      },
      toolCallsUsed: 1,
      turn: 1,
      maxTokensRetries: 0,
      pendingToolState: {
        assistantContent: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "read_file",
            input: { path: "README.md" }
          },
          {
            type: "tool_use",
            id: "tool-2",
            name: "salvo_complete",
            input: completionPayload()
          }
        ],
        toolUses: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "read_file",
            input: { path: "README.md" }
          },
          {
            type: "tool_use",
            id: "tool-2",
            name: "salvo_complete",
            input: completionPayload()
          }
        ],
        nextToolIndex: 1,
        toolResults: [
          {
            type: "tool_result",
            toolUseId: "tool-1",
            content: JSON.stringify({ ok: true, content: "# Readme" })
          }
        ],
        testsRun: [],
        commandResults: []
      }
    }),
    saveCheckpoint: async (state) => {
      savedCheckpoint = state;
    },
    deleteCheckpoint: async () => {
      savedCheckpoint = null;
    }
  });

  assert.equal(result.finalPayload.status, "completed");
  assert.deepEqual(executedTools, ["salvo_complete"]);
  assert.equal(savedCheckpoint, null);
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

test("runAgentLoop blocks when cumulative input token usage exceeds the run budget", async () => {
  const contract = buildContract();
  contract.constraints.max_total_input_tokens = 150;

  const responses: LlmResponse[] = [
    {
      provider: "anthropic",
      model: "claude-sonnet-4",
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 10 },
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
      usage: { inputTokens: 60, outputTokens: 10 },
      content: [
        {
          type: "tool_use",
          id: "tool-2",
          name: "write_file",
          input: { path: "run-summary.md", content: "# blocked" }
        }
      ],
      raw: {}
    }
  ];
  const executedTools: string[] = [];
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];

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
    executeToolUse: async (block) => {
      executedTools.push(block.name);
      return {
        toolResult: {
          type: "tool_result",
          toolUseId: block.id,
          content: JSON.stringify({ ok: true })
        },
        policyDenied: false
      };
    },
    appendRunEvent: async (eventType, _level, payload) => {
      events.push({ eventType, payload });
    }
  });

  assert.equal(result.finalPayload.status, "blocked");
  assert.equal(result.exitReason, "max_total_input_tokens");
  assert.deepEqual(executedTools, ["read_file"]);
  assert.equal(events.some((event) => event.eventType === "resource.limit_reached"), true);
  assert.equal(events.at(-1)?.payload.limit_name, "max_total_input_tokens");
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
  assert.equal(calls, 4);
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

test("runAgentLoop supports a custom completion tool name", async () => {
  const contract = buildContract();

  const result = await runAgentLoop({
    provider: "anthropic",
    model: "claude-sonnet-4",
    systemPrompt: "system",
    userPrompt: "user",
    contract,
    workspaceRoot: "/tmp/workspace",
    completionToolName: "submit_result",
    createMessage: async () => ({
      provider: "anthropic",
      model: "claude-sonnet-4",
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 },
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "submit_result",
          input: completionPayload()
        }
      ],
      raw: {}
    }),
    executeToolUse: async (block): Promise<ToolExecutionOutcome> => ({
      toolResult: {
        type: "tool_result",
        toolUseId: block.id,
        content: JSON.stringify({ ok: true })
      },
      completionPayload: completionPayload(),
      policyDenied: false
    }),
    appendRunEvent: async () => {}
  });

  assert.equal(result.finalPayload.status, "completed");
  assert.equal(result.exitReason, "salvo_complete");
});

test("runAgentLoop blocks plain JSON fallback when artifact persistence is denied", async () => {
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
    executeToolUse: async (block): Promise<ToolExecutionOutcome> => ({
      toolResult: {
        type: "tool_result",
        toolUseId: block.id,
        content: JSON.stringify({ ok: false }),
        isError: true
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
      policyDenied: block.name === "write_file"
    }),
    appendRunEvent: async () => {}
  });

  assert.equal(result.finalPayload.status, "blocked");
  assert.equal(result.exitReason, "policy_denied");
});

test("runAgentLoop preserves denied required test evidence from plain JSON fallback", async () => {
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
    executeToolUse: async (block): Promise<ToolExecutionOutcome> => ({
      toolResult: {
        type: "tool_result",
        toolUseId: block.id,
        content: JSON.stringify({ ok: !block.name.startsWith("run_command") }),
        isError: block.name === "run_command" ? true : undefined
      },
      requiredTestCommandResult:
        block.name === "run_command"
          ? {
              command: "echo salvo-test",
              evidence: {
                command: "echo salvo-test",
                denied: true,
                reason: "command_not_allowlisted",
                message: "blocked"
              }
            }
          : undefined,
      policyDenied: block.name === "run_command"
    }),
    appendRunEvent: async () => {}
  });

  assert.equal(result.finalPayload.status, "blocked");
  assert.equal(result.finalPayload.evidence.tests_run[0]?.command, "echo salvo-test");
  assert.equal(result.finalPayload.evidence.tests_run[0]?.denied, true);
});
