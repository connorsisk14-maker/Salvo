import { buildToolDefinitions, type LlmMessage, type LlmResponse, type SalvoCompletionPayload, type ToolUseBlock, type ToolExecutionOutcome } from "@salvo/llm";
import { usageCostUsd } from "@salvo/shared";
import type { ContractV1 } from "@salvo/contracts";
import {
  normalizeArtifacts,
  parseRunnerModelOutput,
  reserveToolCall,
  type RunnerUsage
} from "./runtime";

export type AgentLoopEventLevel = "debug" | "info" | "warn" | "error";

export type AgentLoopInput = {
  provider: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  contract: ContractV1;
  workspaceRoot: string;
  completionToolName?: string;
  now?: () => number;
  createMessage: (
    systemPrompt: string,
    messages: LlmMessage[],
    tools: ReturnType<typeof buildToolDefinitions>
  ) => Promise<LlmResponse>;
  executeToolUse: (block: ToolUseBlock) => Promise<ToolExecutionOutcome>;
  appendRunEvent: (
    eventType: string,
    level: AgentLoopEventLevel,
    payload: Record<string, unknown>
  ) => Promise<void>;
};

export type AgentLoopResult = {
  finalPayload: SalvoCompletionPayload;
  usage: RunnerUsage;
  exitReason: string;
};

type RequiredTestRun = {
  command: string;
  exit_code?: number;
  denied?: boolean;
};

function buildUsage(response: LlmResponse): RunnerUsage {
  return {
    provider: response.provider,
    model: response.model,
    input_tokens: response.usage.inputTokens,
    output_tokens: response.usage.outputTokens,
    cost_usd: usageCostUsd(response.model, response.usage.inputTokens, response.usage.outputTokens),
    estimated: false,
    pricing_unit: "usd_per_1m_tokens"
  };
}

function emptyUsage(provider: string, model: string): RunnerUsage {
  return {
    provider: provider as RunnerUsage["provider"],
    model,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    estimated: false,
    pricing_unit: "usd_per_1m_tokens"
  };
}

function aggregateUsage(total: RunnerUsage, delta: RunnerUsage): RunnerUsage {
  return {
    ...total,
    provider: delta.provider,
    model: delta.model,
    input_tokens: total.input_tokens + delta.input_tokens,
    output_tokens: total.output_tokens + delta.output_tokens,
    cost_usd: Number((total.cost_usd + delta.cost_usd).toFixed(6))
  };
}

function buildBlockedPayload(input: {
  summary: string;
  reason: string;
  description: string;
  deliverables?: string[];
  testsRun?: RequiredTestRun[];
  commandResults?: Record<string, unknown>[];
  learnings?: SalvoCompletionPayload["learnings"];
}): SalvoCompletionPayload {
  return {
    status: "blocked",
    summary: input.summary,
    deliverables: input.deliverables ?? [],
    evidence: {
      tests_run: input.testsRun ?? [],
      command_results: input.commandResults ?? [],
      files_changed: input.deliverables?.length ?? 0
    },
    roadblocks: [
      {
        type: input.reason,
        description: input.description
      }
    ],
    learnings: input.learnings ?? []
  };
}

function textContent(response: LlmResponse): string {
  return response.content
    .filter((block): block is Extract<LlmResponse["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function testsRunEntry(command: string, evidence: Record<string, unknown>): RequiredTestRun {
  return {
    command,
    exit_code: typeof evidence.exit_code === "number" ? evidence.exit_code : undefined,
    denied: typeof evidence.denied === "boolean" ? evidence.denied : undefined
  };
}

async function appendLlmEvents(
  input: Pick<AgentLoopInput, "appendRunEvent" | "provider" | "model">,
  turn: number,
  response: LlmResponse
): Promise<RunnerUsage> {
  await input.appendRunEvent("tool.called", "info", {
    tool: "llm",
    provider: input.provider,
    model: input.model,
    turn
  });

  await input.appendRunEvent("tool.result", "info", {
    tool: "llm",
    provider: input.provider,
    model: input.model,
    turn,
    stop_reason: response.stopReason,
    content_blocks: response.content.length,
    tool_use_count: response.content.filter((block) => block.type === "tool_use").length
  });

  const usage = buildUsage(response);
  await input.appendRunEvent("usage.reported", "info", usage);
  return usage;
}

async function materializeTextFallback(input: {
  response: LlmResponse;
  contract: ContractV1;
  completionToolName: string;
  executeToolUse: AgentLoopInput["executeToolUse"];
  appendRunEvent: AgentLoopInput["appendRunEvent"];
  toolCallsUsed: number;
}): Promise<{
  finalPayload: SalvoCompletionPayload;
  toolCallsUsed: number;
  exitReason: string;
}> {
  const rawText = textContent(input.response);
  const output = parseRunnerModelOutput(rawText);
  const artifacts = normalizeArtifacts(output, input.contract);
  const deliverables: string[] = [];
  const testsRun: RequiredTestRun[] = [];
  const commandResults: Record<string, unknown>[] = [];

  await input.appendRunEvent("plan.generated", "info", {
    steps: output.plan_steps
  });

  for (const artifact of artifacts) {
    input.toolCallsUsed = reserveToolCall(
      input.toolCallsUsed,
      input.contract.constraints.max_tool_calls,
      "write_file"
    );

    const outcome = await input.executeToolUse({
      type: "tool_use",
      id: `fallback-write-${deliverables.length + 1}`,
      name: "write_file",
      input: {
        path: artifact.path,
        content: artifact.content
      }
    });

    if (outcome.policyDenied && input.contract.failure_handling.stop_on_policy_denial) {
      return {
        finalPayload: buildBlockedPayload({
          summary: output.summary,
          reason: "policy_denied",
          description: "A required artifact write was denied by policy.",
          deliverables,
          testsRun,
          commandResults,
          learnings: output.learnings
        }),
        toolCallsUsed: input.toolCallsUsed,
        exitReason: "policy_denied"
      };
    }

    if (!outcome.policyDenied) {
      deliverables.push(artifact.path);
    }
  }

  for (const testCommand of input.contract.success_criteria.required_test_commands) {
    const [command, ...args] = testCommand.trim().split(/\s+/).filter(Boolean);
    input.toolCallsUsed = reserveToolCall(
      input.toolCallsUsed,
      input.contract.constraints.max_tool_calls,
      "run_command"
    );

    const outcome = await input.executeToolUse({
      type: "tool_use",
      id: `fallback-command-${testsRun.length + 1}`,
      name: "run_command",
      input: {
        command: command ?? "echo",
        args
      }
    });

    const evidence = outcome.requiredTestCommandResult?.evidence ?? {
      command: testCommand,
      denied: outcome.policyDenied
    };

    commandResults.push(evidence);
    testsRun.push(testsRunEntry(testCommand, evidence));

    if (outcome.policyDenied && input.contract.failure_handling.stop_on_policy_denial) {
      return {
        finalPayload: buildBlockedPayload({
          summary: output.summary,
          reason: "policy_denied",
          description: `Required test command was denied: ${testCommand}`,
          deliverables,
          testsRun,
          commandResults,
          learnings: output.learnings
        }),
        toolCallsUsed: input.toolCallsUsed,
        exitReason: "policy_denied"
      };
    }
  }

  return {
    finalPayload: {
      status: "completed",
      summary: output.summary,
      deliverables,
      evidence: {
        tests_run: testsRun,
        command_results: commandResults,
        files_changed: deliverables.length
      },
      roadblocks: [],
      learnings: output.learnings
    },
    toolCallsUsed: input.toolCallsUsed,
    exitReason: "salvo_complete"
  };
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const completionToolName = input.completionToolName?.trim() || "salvo_complete";
  const tools = buildToolDefinitions(input.contract, {
    completionToolName
  });
  const requiredTestCommands = new Set(input.contract.success_criteria.required_test_commands);
  const messages: LlmMessage[] = [
    {
      role: "user",
      content: input.userPrompt
    }
  ];

  const usage = emptyUsage(input.provider, input.model);
  let toolCallsUsed = 0;
  let turn = 0;
  let maxTokensRetries = 0;

  while (true) {
    if (now() - startedAt > input.contract.constraints.max_runtime_minutes * 60_000) {
      return {
        finalPayload: buildBlockedPayload({
          summary: "Agent loop stopped before completion.",
          reason: "max_runtime",
          description: "Agent loop exceeded the contract runtime limit."
        }),
        usage,
        exitReason: "max_runtime"
      };
    }

    turn += 1;
    const response = await input.createMessage(input.systemPrompt, messages, tools);
    Object.assign(usage, aggregateUsage(usage, await appendLlmEvents(input, turn, response)));

    if (response.content.length > 0) {
      messages.push({
        role: "assistant",
        content: response.content
      });
    }

    const toolUses = response.content.filter(
      (block): block is ToolUseBlock => block.type === "tool_use"
    );

    if (toolUses.length > 0) {
      const toolResults = [];
      const testsRun: RequiredTestRun[] = [];
      const commandResults: Record<string, unknown>[] = [];

      for (const block of toolUses) {
        try {
          toolCallsUsed = reserveToolCall(
            toolCallsUsed,
            input.contract.constraints.max_tool_calls,
            block.name
          );
        } catch (error) {
          await input.appendRunEvent("policy.denied", "warn", {
            reason: "tool_call_limit",
            message: (error as Error).message,
            max_tool_calls: input.contract.constraints.max_tool_calls,
            tool_calls_used: toolCallsUsed,
            tool: block.name
          });

          return {
            finalPayload: buildBlockedPayload({
              summary: "Agent loop stopped before completion.",
              reason: "tool_call_limit",
              description: (error as Error).message
            }),
            usage,
            exitReason: "tool_call_limit"
          };
        }

        const outcome = await input.executeToolUse(block);
        toolResults.push(outcome.toolResult);

        if (outcome.requiredTestCommandResult) {
          commandResults.push(outcome.requiredTestCommandResult.evidence);
          testsRun.push(
            testsRunEntry(outcome.requiredTestCommandResult.command, outcome.requiredTestCommandResult.evidence)
          );
        }

        if (outcome.policyDenied && input.contract.failure_handling.stop_on_policy_denial) {
          return {
            finalPayload: buildBlockedPayload({
              summary: "Agent loop stopped before completion.",
              reason: "policy_denied",
              description: `Tool execution was denied for ${block.name}.`,
              testsRun,
              commandResults
            }),
            usage,
            exitReason: "policy_denied"
          };
        }

        if (outcome.completionPayload) {
          return {
            finalPayload: outcome.completionPayload,
            usage,
            exitReason: "salvo_complete"
          };
        }
      }

      if (toolResults.length > 0) {
        messages.push({
          role: "tool",
          content: toolResults
        });
      }
    } else {
      const rawText = textContent(response);
      if (rawText) {
        try {
          const fallback = await materializeTextFallback({
            response,
            contract: input.contract,
            completionToolName,
            executeToolUse: async (block) =>
              input.executeToolUse({
                ...block,
                input: block.name === "run_command"
                  ? {
                      ...block.input,
                      cwd: input.workspaceRoot
                    }
                  : block.input
              }),
            appendRunEvent: input.appendRunEvent,
            toolCallsUsed
          });

          toolCallsUsed = fallback.toolCallsUsed;
          return {
            finalPayload: fallback.finalPayload,
            usage,
            exitReason: fallback.exitReason
          };
        } catch (error) {
          if (response.stopReason === "max_tokens" && maxTokensRetries < 2) {
            maxTokensRetries += 1;
            messages.push({
              role: "user",
              content: "Continue from the prior response without repeating finished content."
            });
            continue;
          }
        }
      }
    }

    if (response.stopReason === "max_tokens") {
      if (maxTokensRetries >= 2) {
        return {
          finalPayload: buildBlockedPayload({
            summary: "Agent loop stopped before completion.",
            reason: "max_tokens",
            description: "LLM output exhausted the continuation retry cap without completing."
          }),
          usage,
          exitReason: "max_tokens"
        };
      }

      maxTokensRetries += 1;
      messages.push({
        role: "user",
        content: "Continue from the prior response without repeating finished content."
      });
      continue;
    }

    maxTokensRetries = 0;

    if (response.stopReason === "end_turn") {
      return {
        finalPayload: buildBlockedPayload({
          summary: "Agent loop ended without a completion payload.",
          reason: "end_turn",
          description: "LLM ended the turn without calling the completion tool."
        }),
        usage,
        exitReason: "end_turn"
      };
    }
  }
}
