export type OrchestratorSoulPromptContext = {
  workspace: {
    id: string;
    name: string;
    localPath: string;
    topLevelEntries: string[];
  };
  contractFamilies?: Array<{
    familyKey: string;
    memoryIds: string[];
  }>;
  recentRunHistory?: Array<{
    runId: string;
  }>;
  activeResearchFindings?: Array<{
    id: string;
    confidence: number;
  }>;
};

function formatList(items: string[]): string {
  if (items.length === 0) {
    return "- none";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

export function buildOrchestratorSoulPrompt(
  context: OrchestratorSoulPromptContext
): string {
  const contractFamilies = context.contractFamilies ?? [];
  const recentRunHistory = context.recentRunHistory ?? [];
  const activeResearchFindings = context.activeResearchFindings ?? [];

  return [
    "# Salvo Orchestrator Soul Prompt",
    "You are the Salvo orchestrator. Operate with autonomy inside structural safety: scope tightly, act decisively, and preserve the contract protocol.",
    "Bias toward action over deliberation. Prefer the smallest safe contract that can complete the task with clear evidence and required deliverables.",
    "Use workspace state, contract families, recent runs, and accepted research findings to avoid generic plans and repeated mistakes.",
    "Return only a valid JSON object that fully satisfies the ContractV1 schema.",
    "Use the provided contract_id, task_id, workspace_id, and created_at exactly as given.",
    "Keep family_key unchanged when the task clearly belongs to an existing accepted family.",
    "Use task-specific read_paths, write_paths, forbidden_paths, and required_test_commands.",
    "If memory excerpts or research findings are relevant, carry their ids into the contract context.",
    "## Workspace State",
    `- workspace_id: ${context.workspace.id}`,
    `- workspace_name: ${context.workspace.name}`,
    `- local_path: ${context.workspace.localPath}`,
    `Top level entries:\n${formatList(context.workspace.topLevelEntries)}`,
    "## Contract Families",
    formatList(
      contractFamilies.map((family) => `${family.familyKey} (memories: ${family.memoryIds.join(", ") || "none"})`)
    ),
    "## Recent Run History",
    formatList(recentRunHistory.map((entry) => entry.runId)),
    "## Active Research Findings",
    formatList(
      activeResearchFindings.map((finding) => `${finding.id} (confidence: ${finding.confidence})`)
    )
  ].join("\n\n");
}
