import {
  buildToolDefinitions,
  type LlmMessage,
  type LlmResponse,
  type SalvoCompletionPayload,
  type ToolResultBlock,
  type ToolUseBlock,
  type ToolExecutionOutcome
} from "@salvo/llm";
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
  startedAtMs?: number;
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
  loadCheckpoint?: () => Promise<AgentLoopCheckpointState | null>;
  saveCheckpoint?: (state: AgentLoopCheckpointState) => Promise<void>;
  deleteCheckpoint?: () => Promise<void>;
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

type ResourceLimitViolation = {
  reason: "max_total_input_tokens" | "max_total_output_tokens" | "max_total_cost_usd";
  description: string;
  payload: Record<string, unknown>;
};

type PendingToolState = {
  assistantContent: LlmResponse["content"];
  toolUses: ToolUseBlock[];
  nextToolIndex: number;
  toolResults: ToolResultBlock[];
  testsRun: RequiredTestRun[];
  commandResults: Record<string, unknown>[];
};

export type AgentLoopCheckpointState = {
  schemaVersion: 1;
  messages: LlmMessage[];
  usage: RunnerUsage;
  toolCallsUsed: number;
  turn: number;
  maxTokensRetries: number;
  pendingToolState: PendingToolState | null;
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

function cloneCheckpointState(state: AgentLoopCheckpointState): AgentLoopCheckpointState {
  return JSON.parse(JSON.stringify(state)) as AgentLoopCheckpointState;
}

function clonePendingToolState(state: PendingToolState): PendingToolState {
  return JSON.parse(JSON.stringify(state)) as PendingToolState;
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

function detectResourceLimitViolation(
  contract: ContractV1,
  usage: RunnerUsage
): ResourceLimitViolation | null {
  if (usage.input_tokens > contract.constraints.max_total_input_tokens) {
    return {
      reason: "max_total_input_tokens",
      description: `Run exceeded the input token limit of ${contract.constraints.max_total_input_tokens}.`,
      payload: {
        limit_name: "max_total_input_tokens",
        limit: contract.constraints.max_total_input_tokens,
        observed: usage.input_tokens
      }
    };
  }

  if (usage.output_tokens > contract.constraints.max_total_output_tokens) {
    return {
      reason: "max_total_output_tokens",
      description: `Run exceeded the output token limit of ${contract.constraints.max_total_output_tokens}.`,
      payload: {
        limit_name: "max_total_output_tokens",
        limit: contract.constraints.max_total_output_tokens,
        observed: usage.output_tokens
      }
    };
  }

  if (usage.cost_usd > contract.constraints.max_total_cost_usd) {
    return {
      reason: "max_total_cost_usd",
      description: `Run exceeded the cost limit of $${contract.constraints.max_total_cost_usd.toFixed(2)}.`,
      payload: {
        limit_name: "max_total_cost_usd",
        limit: contract.constraints.max_total_cost_usd,
        observed: Number(usage.cost_usd.toFixed(6))
      }
    };
  }

  return null;
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
  const startedAt = input.startedAtMs ?? now();
  const completionToolName = input.completionToolName?.trim() || "salvo_complete";
  const tools = buildToolDefinitions(input.contract, {
    completionToolName
  });
  const requiredTestCommands = new Set(input.contract.success_criteria.required_test_commands);
  const checkpoint = await input.loadCheckpoint?.();
  const messages: LlmMessage[] =
    checkpoint?.messages ?? [
      {
        role: "user",
        content: input.userPrompt
      }
    ];

  const usage = checkpoint?.usage ?? emptyUsage(input.provider, input.model);
  let toolCallsUsed = checkpoint?.toolCallsUsed ?? 0;
  let turn = checkpoint?.turn ?? 0;
  let maxTokensRetries = checkpoint?.maxTokensRetries ?? 0;
  let pendingToolState = checkpoint?.pendingToolState ?? null;

  const persistCheckpoint = async (): Promise<void> => {
    if (!input.saveCheckpoint) {
      return;
    }
    await input.saveCheckpoint(
      cloneCheckpointState({
        schemaVersion: 1,
        messages,
        usage,
        toolCallsUsed,
        turn,
        maxTokensRetries,
        pendingToolState
      })
    );
  };

  const clearCheckpoint = async (): Promise<void> => {
    pendingToolState = null;
    if (input.deleteCheckpoint) {
      await input.deleteCheckpoint();
    }
  };

  const executeToolBatch = async (state: PendingToolState): Promise<AgentLoopResult | null> => {
    const toolResults = [...state.toolResults];
    const testsRun = [...state.testsRun];
    const commandResults = [...state.commandResults];

    for (let index = state.nextToolIndex; index < state.toolUses.length; index += 1) {
      const block = state.toolUses[index];
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
        await clearCheckpoint();
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

      pendingToolState = {
        assistantContent: clonePendingToolState(state).assistantContent,
        toolUses: clonePendingToolState(state).toolUses,
        nextToolIndex: index + 1,
        toolResults: [...toolResults],
        testsRun: [...testsRun],
        commandResults: [...commandResults]
      };
      await persistCheckpoint();

      if (outcome.policyDenied && input.contract.failure_handling.stop_on_policy_denial) {
        await clearCheckpoint();
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
        await clearCheckpoint();
        return {
          finalPayload: outcome.completionPayload,
          usage,
          exitReason: "salvo_complete"
        };
      }
    }

    messages.push({
      role: "assistant",
      content: state.assistantContent
    });

    if (toolResults.length > 0) {
      messages.push({
        role: "tool",
        content: toolResults
      });
    }

    pendingToolState = null;
    await persistCheckpoint();
    return null;
  };

  while (true) {
    if (now() - startedAt > input.contract.constraints.max_runtime_minutes * 60_000) {
      await clearCheckpoint();
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

    if (pendingToolState) {
      const resumedResult = await executeToolBatch(pendingToolState);
      if (resumedResult) {
        return resumedResult;
      }
      continue;
    }

    turn += 1;
    const response = await input.createMessage(input.systemPrompt, messages, tools);
    Object.assign(usage, aggregateUsage(usage, await appendLlmEvents(input, turn, response)));

    const resourceLimitViolation = detectResourceLimitViolation(input.contract, usage);
    if (resourceLimitViolation) {
      await input.appendRunEvent("resource.limit_reached", "warn", resourceLimitViolation.payload);
      await clearCheckpoint();
      return {
        finalPayload: buildBlockedPayload({
          summary: "Agent loop stopped before completion.",
          reason: "resource_limit",
          description: resourceLimitViolation.description
        }),
        usage,
        exitReason: resourceLimitViolation.reason
      };
    }

    const toolUses = response.content.filter(
      (block): block is ToolUseBlock => block.type === "tool_use"
    );

    if (toolUses.length > 0) {
      pendingToolState = {
        assistantContent: response.content,
        toolUses: toolUses.map((block) => JSON.parse(JSON.stringify(block)) as ToolUseBlock),
        nextToolIndex: 0,
        toolResults: [],
        testsRun: [],
        commandResults: []
      };
      await persistCheckpoint();

      const batchResult = await executeToolBatch(pendingToolState);
      if (batchResult) {
        return batchResult;
      }
    } else {
      if (response.content.length > 0) {
        messages.push({
          role: "assistant",
          content: response.content
        });
      }

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
          await clearCheckpoint();
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
            await persistCheckpoint();
            continue;
          }
        }
      }
    }

    if (response.stopReason === "max_tokens") {
      if (maxTokensRetries >= 2) {
        await clearCheckpoint();
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
      await persistCheckpoint();
      continue;
    }

    maxTokensRetries = 0;

    if (response.stopReason === "end_turn") {
      await clearCheckpoint();
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
