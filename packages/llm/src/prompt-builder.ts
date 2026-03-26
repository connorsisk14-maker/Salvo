import type { ContractV1 } from "@salvo/contracts";

export type PromptMemoryExcerpt = {
  id?: string;
  title?: string;
  summary?: string;
  body?: string;
};

export type PriorRunSummary = {
  runId?: string;
  summary: string;
};

export type BuildSystemPromptInput = {
  contract: ContractV1;
  memoryExcerpts?: PromptMemoryExcerpt[];
  priorRunSummaries?: PriorRunSummary[];
  completionToolName?: string;
};

function formatList(items: string[]): string {
  if (items.length === 0) {
    return "- none";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function formatCapabilityList(contract: ContractV1): string {
  const capabilityEntries = [
    ["filesystem_read", contract.capabilities.filesystem_read],
    ["filesystem_write", contract.capabilities.filesystem_write],
    ["run_tests", contract.capabilities.run_tests],
    ["install_packages", contract.capabilities.install_packages],
    ["network_access", contract.capabilities.network_access],
    ["db_read", contract.capabilities.db_read],
    ["db_write", contract.capabilities.db_write],
    ["email_send", contract.capabilities.email_send],
    ["slack_send", contract.capabilities.slack_send]
  ];

  return capabilityEntries
    .map(([name, enabled]) => `- ${name}: ${enabled ? "granted" : "denied"}`)
    .join("\n");
}

function formatMemoryExcerpts(memoryExcerpts: PromptMemoryExcerpt[]): string {
  return memoryExcerpts
    .map((excerpt, index) => {
      const header = excerpt.title?.trim() || excerpt.id?.trim() || `memory-${index + 1}`;
      const details = [excerpt.summary?.trim(), excerpt.body?.trim()].filter(
        (value): value is string => Boolean(value && value.length > 0)
      );

      return `### ${header}\n${details.join("\n\n")}`;
    })
    .join("\n\n");
}

function formatPriorRunSummaries(priorRunSummaries: PriorRunSummary[]): string {
  return priorRunSummaries
    .map((entry, index) => {
      const header = entry.runId?.trim() || `run-${index + 1}`;
      return `### ${header}\n${entry.summary.trim()}`;
    })
    .join("\n\n");
}

export function buildSystemPrompt(input: BuildSystemPromptInput): string {
  const memoryExcerpts = input.memoryExcerpts ?? [];
  const priorRunSummaries = input.priorRunSummaries ?? [];
  const completionToolName = input.completionToolName ?? "salvo_complete";

  const sections = [
    "# Salvo Agent System Prompt",
    "You are executing a bounded Salvo contract. Stay inside the granted scope, produce the required deliverables, and do not improvise beyond the contract.",
    "## Objective",
    `Primary objective: ${input.contract.objective.primary}`,
    `Secondary objectives:\n${formatList(input.contract.objective.secondary)}`,
    `Non-goals:\n${formatList(input.contract.objective.non_goals)}`,
    "## Scope Boundaries",
    `Read paths:\n${formatList(input.contract.scope.read_paths)}`,
    `Write paths:\n${formatList(input.contract.scope.write_paths)}`,
    `Forbidden paths:\n${formatList(input.contract.scope.forbidden_paths)}`,
    "## Capabilities",
    formatCapabilityList(input.contract),
    "## Constraints",
    `- max_runtime_minutes: ${input.contract.constraints.max_runtime_minutes}`,
    `- max_tool_calls: ${input.contract.constraints.max_tool_calls}`,
    `- no_destructive_commands: ${input.contract.constraints.no_destructive_commands ? "true" : "false"}`,
    `- approval_required_for:\n${formatList(input.contract.constraints.approval_required_for)}`,
    "## Deliverables",
    `Required artifacts:\n${formatList(input.contract.deliverables.required_artifacts)}`,
    `- evidence_required: ${input.contract.deliverables.evidence_required ? "true" : "false"}`,
    `- summary_required: ${input.contract.deliverables.summary_required ? "true" : "false"}`,
    "## Success Criteria",
    `Required test commands:\n${formatList(input.contract.success_criteria.required_test_commands)}`,
    `Assertions:\n${formatList(input.contract.success_criteria.assertions)}`,
    "## Completion Protocol",
    `When tool calling is available, finish by calling \`${completionToolName}\` with the final payload once the work is complete.`,
    "If the runtime asks for plain JSON output instead, return a strict JSON object with keys `plan_steps`, `summary`, `artifacts`, and `learnings`.",
    "Do not claim success unless the produced artifacts and evidence satisfy the contract."
  ];

  if (memoryExcerpts.length > 0) {
    sections.push("## Memory Excerpts", formatMemoryExcerpts(memoryExcerpts));
  }

  if (priorRunSummaries.length > 0) {
    sections.push("## Prior Run Summaries", formatPriorRunSummaries(priorRunSummaries));
  }

  return sections.join("\n\n");
}
