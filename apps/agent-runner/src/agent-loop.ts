import {
  buildToolDefinitions,
  PLAN_STEP_COMPLETE_INPUT_SCHEMA,
  type LlmToolDefinition,
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
  skillRegistry?: {
    list(): Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>;
  };
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

type ExecutionPlanStep = {
  id: string;
  title: string;
  expectedInputs: string[];
  expectedOutputs: string[];
  completionSummary?: string;
  outputs?: string[];
};

type ExecutionPlanState = {
  summary: string;
  steps: ExecutionPlanStep[];
  currentStepIndex: number;
  source: "llm" | "heuristic";
};

export type AgentLoopCheckpointState = {
  schemaVersion: 1 | 2;
  messages: LlmMessage[];
  usage: RunnerUsage;
  toolCallsUsed: number;
  turn: number;
  maxTokensRetries: number;
  pendingToolState: PendingToolState | null;
  planState?: ExecutionPlanState | null;
};

const PLAN_STEP_COMPLETE_TOOL: LlmToolDefinition = {
  name: "plan_step_complete",
  description: "Mark the current execution-plan step as complete after its required work is done.",
  inputSchema: PLAN_STEP_COMPLETE_INPUT_SCHEMA
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

function clonePlanState(state: ExecutionPlanState): ExecutionPlanState {
  return JSON.parse(JSON.stringify(state)) as ExecutionPlanState;
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM response did not contain a JSON object.");
  }
  return candidate.slice(start, end + 1);
}

function normalizePlanStep(raw: unknown, index: number): ExecutionPlanStep | null {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return {
      id: `step-${index + 1}`,
      title: raw.trim(),
      expectedInputs: [],
      expectedOutputs: []
    };
  }

  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const rawStep = raw as {
    id?: unknown;
    title?: unknown;
    summary?: unknown;
    expected_inputs?: unknown;
    expected_outputs?: unknown;
  };
  const title =
    typeof rawStep.title === "string" && rawStep.title.trim().length > 0
      ? rawStep.title.trim()
      : typeof rawStep.summary === "string" && rawStep.summary.trim().length > 0
        ? rawStep.summary.trim()
        : "";
  if (!title) {
    return null;
  }

  return {
    id:
      typeof rawStep.id === "string" && rawStep.id.trim().length > 0
        ? rawStep.id.trim()
        : `step-${index + 1}`,
    title,
    expectedInputs: Array.isArray(rawStep.expected_inputs)
      ? rawStep.expected_inputs.flatMap((value) =>
          typeof value === "string" && value.trim().length > 0 ? [value.trim()] : []
        )
      : [],
    expectedOutputs: Array.isArray(rawStep.expected_outputs)
      ? rawStep.expected_outputs.flatMap((value) =>
          typeof value === "string" && value.trim().length > 0 ? [value.trim()] : []
        )
      : []
  };
}

function heuristicPlan(contract: ContractV1): ExecutionPlanState {
  const steps: ExecutionPlanStep[] = [];

  steps.push({
    id: "step-1",
    title: "Review the contract scope and inspect the workspace context.",
    expectedInputs: ["contract", "workspace context"],
    expectedOutputs: []
  });

  if (contract.deliverables.required_artifacts.length > 0) {
    steps.push({
      id: `step-${steps.length + 1}`,
      title: "Produce the required artifacts.",
      expectedInputs: contract.context.relevant_files.slice(0, 5),
      expectedOutputs: contract.deliverables.required_artifacts.slice(0, 5)
    });
  }

  if (contract.success_criteria.required_test_commands.length > 0) {
    steps.push({
      id: `step-${steps.length + 1}`,
      title: "Run the required verification commands.",
      expectedInputs: contract.success_criteria.required_test_commands.slice(0, 5),
      expectedOutputs: ["verification evidence"]
    });
  }

  if (steps.length === 0) {
    steps.push({
      id: "step-1",
      title: "Complete the task within the contract scope.",
      expectedInputs: ["task request"],
      expectedOutputs: []
    });
  }

  return {
    summary: "Heuristic execution plan derived from the contract.",
    steps,
    currentStepIndex: 0,
    source: "heuristic"
  };
}

function parseExecutionPlan(rawText: string, contract: ContractV1): ExecutionPlanState {
  try {
    const parsed = JSON.parse(extractJsonObject(rawText)) as {
      summary?: unknown;
      steps?: unknown;
      plan_steps?: unknown;
    };
    const rawSteps = Array.isArray(parsed.steps)
      ? parsed.steps
      : Array.isArray(parsed.plan_steps)
        ? parsed.plan_steps
        : [];
    const steps = rawSteps
      .map((step, index) => normalizePlanStep(step, index))
      .filter((step): step is ExecutionPlanStep => step !== null);

    if (steps.length === 0 || steps.length > contract.constraints.max_tool_calls) {
      return heuristicPlan(contract);
    }

    return {
      summary:
        typeof parsed.summary === "string" && parsed.summary.trim().length > 0
          ? parsed.summary.trim()
          : "LLM-generated execution plan.",
      steps,
      currentStepIndex: 0,
      source: "llm"
    };
  } catch {
    return heuristicPlan(contract);
  }
}

function currentPlanStep(planState: ExecutionPlanState | null): ExecutionPlanStep | null {
  if (!planState) {
    return null;
  }
  return planState.steps[planState.currentStepIndex] ?? null;
}

function buildPlanPrompt(userPrompt: string): string {
  return [
    userPrompt,
    "Before using tools, produce a strict JSON object with keys `summary` and `steps`.",
    "Each step must include `id`, `title`, `expected_inputs`, and `expected_outputs`.",
    "Keep the plan concise, ordered, and limited to the contract scope."
  ].join("\n\n");
}

function buildPlanExecutionPrompt(planState: ExecutionPlanState): string {
  const activeStep = currentPlanStep(planState);
  return [
    `Approved plan summary: ${planState.summary}`,
    "Execute the plan in order.",
    "Call `plan_step_complete` when the current step is complete before moving on.",
    `Current step: ${activeStep?.id ?? "done"}${activeStep ? ` - ${activeStep.title}` : ""}`,
    `Plan:\n${JSON.stringify(planState.steps, null, 2)}`
  ].join("\n\n");
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

async function emitPlanGenerated(
  input: Pick<AgentLoopInput, "appendRunEvent">,
  planState: ExecutionPlanState
): Promise<void> {
  await input.appendRunEvent("plan.generated", "info", {
    source: planState.source,
    summary: planState.summary,
    steps: planState.steps.map((step, index) => ({
      id: step.id,
      title: step.title,
      expected_inputs: step.expectedInputs,
      expected_outputs: step.expectedOutputs,
      order: index + 1
    }))
  });
}

async function emitPlanStepStarted(
  input: Pick<AgentLoopInput, "appendRunEvent">,
  planState: ExecutionPlanState
): Promise<void> {
  const step = currentPlanStep(planState);
  if (!step) {
    return;
  }

  await input.appendRunEvent("plan.step.started", "info", {
    step_id: step.id,
    title: step.title,
    index: planState.currentStepIndex + 1,
    total: planState.steps.length,
    expected_inputs: step.expectedInputs,
    expected_outputs: step.expectedOutputs
  });
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
  executeToolUse: AgentLoopInput["executeToolUse"];
  appendRunEvent: AgentLoopInput["appendRunEvent"];
  toolCallsUsed: number;
  planState: ExecutionPlanState | null;
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

  if (input.planState) {
    for (let index = input.planState.currentStepIndex; index < input.planState.steps.length; index += 1) {
      const step = input.planState.steps[index];
      await input.appendRunEvent("plan.step.completed", "info", {
        step_id: step.id,
        title: step.title,
        index: index + 1,
        total: input.planState.steps.length,
        summary: output.summary,
        outputs: output.plan_steps.map((entry) =>
          typeof entry === "string" ? entry : JSON.stringify(entry)
        )
      });
    }
  }

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
    completionToolName,
    skillRegistry: input.skillRegistry,
    additionalDefinitions: [PLAN_STEP_COMPLETE_TOOL]
  });
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
  let planState = checkpoint?.planState ?? null;

  const persistCheckpoint = async (): Promise<void> => {
    if (!input.saveCheckpoint) {
      return;
    }
    await input.saveCheckpoint(
      cloneCheckpointState({
        schemaVersion: 2,
        messages,
        usage,
        toolCallsUsed,
        turn,
        maxTokensRetries,
        pendingToolState,
        planState
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

      if (
        block.name === completionToolName &&
        planState?.source === "llm" &&
        currentPlanStep(planState)
      ) {
        const step = currentPlanStep(planState) as ExecutionPlanStep;
        await input.appendRunEvent("plan.deviation_detected", "warn", {
          reason: "completion_before_plan_finished",
          active_step_id: step.id,
          active_step_title: step.title
        });
        await clearCheckpoint();
        return {
          finalPayload: buildBlockedPayload({
            summary: "Agent loop attempted to finish before all plan steps were complete.",
            reason: "plan_deviation",
            description: `The active plan step ${step.id} must be completed before ${completionToolName}.`
          }),
          usage,
          exitReason: "plan_deviation"
        };
      }

      if (block.name === "plan_step_complete") {
        const activeStep = currentPlanStep(planState);
        const requestedStepId =
          typeof block.input.step_id === "string" ? block.input.step_id.trim() : "";
        const summary =
          typeof block.input.summary === "string" ? block.input.summary.trim() : "";
        const outputs = Array.isArray(block.input.outputs)
          ? block.input.outputs.flatMap((value) =>
              typeof value === "string" && value.trim().length > 0 ? [value.trim()] : []
            )
          : [];

        if (!activeStep || !requestedStepId || requestedStepId !== activeStep.id || !summary) {
          await input.appendRunEvent("plan.deviation_detected", "warn", {
            reason: "invalid_step_completion",
            requested_step_id: requestedStepId || null,
            active_step_id: activeStep?.id ?? null
          });
          await clearCheckpoint();
          return {
            finalPayload: buildBlockedPayload({
              summary: "Agent loop deviated from the approved execution plan.",
              reason: "plan_deviation",
              description: "Step completion must match the currently active plan step."
            }),
            usage,
            exitReason: "plan_deviation"
          };
        }

        toolResults.push({
          type: "tool_result",
          toolUseId: block.id,
          content: JSON.stringify({
            ok: true,
            step_id: activeStep.id,
            next_step_id: planState?.steps[planState.currentStepIndex + 1]?.id ?? null
          })
        });

        if (planState) {
          planState.steps[planState.currentStepIndex] = {
            ...planState.steps[planState.currentStepIndex],
            completionSummary: summary,
            outputs
          };
          await input.appendRunEvent("plan.step.completed", "info", {
            step_id: activeStep.id,
            title: activeStep.title,
            index: planState.currentStepIndex + 1,
            total: planState.steps.length,
            summary,
            outputs
          });
          planState.currentStepIndex += 1;
          if (currentPlanStep(planState)) {
            await emitPlanStepStarted(input, planState);
          }
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
        continue;
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

  if (!planState && !pendingToolState) {
    turn += 1;
    const planResponse = await input.createMessage(input.systemPrompt, [
      {
        role: "user",
        content: buildPlanPrompt(input.userPrompt)
      }
    ], []);
    Object.assign(usage, aggregateUsage(usage, await appendLlmEvents(input, turn, planResponse)));

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

    const hasToolUses = planResponse.content.some((block) => block.type === "tool_use");
    planState = parseExecutionPlan(textContent(planResponse), input.contract);
    await emitPlanGenerated(input, planState);
    await emitPlanStepStarted(input, planState);
    if (hasToolUses) {
      pendingToolState = {
        assistantContent: planResponse.content,
        toolUses: planResponse.content
          .filter((block): block is ToolUseBlock => block.type === "tool_use")
          .map((block) => JSON.parse(JSON.stringify(block)) as ToolUseBlock),
        nextToolIndex: 0,
        toolResults: [],
        testsRun: [],
        commandResults: []
      };
    } else {
      messages.push({
        role: "assistant",
        content: planResponse.content.length > 0
          ? planResponse.content
          : [{ type: "text", text: JSON.stringify(planState) }]
      });
      messages.push({
        role: "user",
        content: buildPlanExecutionPrompt(planState)
      });
    }
    await persistCheckpoint();
  }

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
            toolCallsUsed,
            planState
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
