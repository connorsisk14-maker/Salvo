import { z } from "zod";
import {
  AGENT_PROFILES,
  assertContractTransition,
  type AgentProfile,
  type ContractStatus,
  type WorkspaceId
} from "@salvo/shared";

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const APPROVAL_REQUIRED_BY_RISK: Record<RiskLevel, boolean> = {
  low: false,
  medium: false,
  high: true
};

export const ContractCapabilitiesSchema = z.object({
  filesystem_read: z.boolean(),
  filesystem_write: z.boolean(),
  run_tests: z.boolean(),
  install_packages: z.boolean(),
  network_access: z.boolean(),
  db_read: z.boolean(),
  db_write: z.boolean()
});

export const ContractV1Schema = z.object({
  schema_version: z.literal(1),
  contract_id: z.string().uuid(),
  task_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  created_at: z.string().datetime(),
  objective: z.object({
    primary: z.string().min(1),
    secondary: z.array(z.string()).default([]),
    non_goals: z.array(z.string()).default([])
  }),
  context: z.object({
    relevant_files: z.array(z.string()).default([]),
    recent_runs: z.array(z.string().uuid()).default([]),
    memory_excerpt_ids: z.array(z.string().uuid()).default([])
  }),
  scope: z.object({
    read_paths: z.array(z.string()).default([]),
    write_paths: z.array(z.string()).default([]),
    forbidden_paths: z.array(z.string()).default([])
  }),
  capabilities: ContractCapabilitiesSchema,
  constraints: z.object({
    max_runtime_minutes: z.number().int().positive().default(25),
    max_tool_calls: z.number().int().positive().default(200),
    no_destructive_commands: z.boolean().default(true),
    approval_required_for: z.array(z.string()).default([])
  }),
  deliverables: z.object({
    required_artifacts: z.array(z.string()).default([]),
    evidence_required: z.boolean().default(true),
    summary_required: z.boolean().default(true)
  }),
  success_criteria: z.object({
    required_test_commands: z.array(z.string()).default([]),
    assertions: z.array(z.string()).default([])
  }),
  failure_handling: z.object({
    stop_on_policy_denial: z.boolean().default(true)
  }),
  learnings_output: z.object({
    required: z.boolean().default(true)
  }),
  risk: z.enum(RISK_LEVELS),
  agent_profile: z.enum(AGENT_PROFILES)
});

export type ContractV1 = z.infer<typeof ContractV1Schema>;

export type BuildContractInput = {
  contractId: string;
  taskId: string;
  workspaceId: WorkspaceId;
  request: string;
  taskTitle: string;
  preferredProfile?: AgentProfile;
};

function classifyRisk(request: string): RiskLevel {
  const lowered = request.toLowerCase();
  if (
    lowered.includes("schema") ||
    lowered.includes("migration") ||
    lowered.includes("delete") ||
    lowered.includes("drop") ||
    lowered.includes("install")
  ) {
    return "high";
  }

  if (lowered.includes("refactor") || lowered.includes("rename")) {
    return "medium";
  }

  return "low";
}

export function buildContractV1(input: BuildContractInput): ContractV1 {
  const risk = classifyRisk(input.request);
  const approvalRequired = APPROVAL_REQUIRED_BY_RISK[risk];

  return ContractV1Schema.parse({
    schema_version: 1,
    contract_id: input.contractId,
    task_id: input.taskId,
    workspace_id: input.workspaceId,
    created_at: new Date().toISOString(),
    objective: {
      primary: input.taskTitle,
      secondary: [],
      non_goals: ["Do not modify files outside allowed scope."]
    },
    context: {
      relevant_files: [],
      recent_runs: [],
      memory_excerpt_ids: []
    },
    scope: {
      read_paths: ["."],
      write_paths: ["."],
      forbidden_paths: [".env", ".git", "node_modules"]
    },
    capabilities: {
      filesystem_read: true,
      filesystem_write: true,
      run_tests: true,
      install_packages: false,
      network_access: false,
      db_read: true,
      db_write: true
    },
    constraints: {
      max_runtime_minutes: 25,
      max_tool_calls: 200,
      no_destructive_commands: true,
      approval_required_for: approvalRequired
        ? ["schema_change", "dependency_install"]
        : []
    },
    deliverables: {
      required_artifacts: ["run-summary.md"],
      evidence_required: true,
      summary_required: true
    },
    success_criteria: {
      required_test_commands: [],
      assertions: ["Runner emits a final payload event."]
    },
    failure_handling: {
      stop_on_policy_denial: true
    },
    learnings_output: {
      required: true
    },
    risk,
    agent_profile: input.preferredProfile ?? "builder"
  });
}

export function canTransitionContract(
  current: ContractStatus,
  next: ContractStatus
): boolean {
  try {
    assertContractTransition(current, next);
    return true;
  } catch {
    return false;
  }
}

export function validateContractV1(contract: unknown): ContractV1 {
  return ContractV1Schema.parse(contract);
}
