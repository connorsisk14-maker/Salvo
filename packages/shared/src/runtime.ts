export const TASK_STATUSES = [
  "queued",
  "planning",
  "running",
  "blocked",
  "completed",
  "failed",
  "needs_review",
  "cancelled"
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["urgent", "high", "medium", "low"] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const DEFAULT_TASK_PRIORITY: TaskPriority = "medium";

export const CONTRACT_STATUSES = [
  "draft",
  "approved",
  "active",
  "superseded",
  "closed"
] as const;

export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_CATEGORIES = [
  "general",
  "integration",
  "migration",
  "debug",
  "quality",
  "documentation",
  "operations"
] as const;

export type ContractCategory = (typeof CONTRACT_CATEGORIES)[number];

export const RUN_STATUSES = [
  "created",
  "provisioning",
  "starting",
  "running",
  "evaluating",
  "completed",
  "failed",
  "blocked",
  "cancelled"
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "blocked",
  "cancelled"
] as const;

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export const RUN_EXIT_REASONS = [
  "success",
  "policy_violation",
  "timeout",
  "runner_crash",
  "stale_runner",
  "evaluation_failed",
  "cancelled",
  "unknown"
] as const;

export type RunExitReason = (typeof RUN_EXIT_REASONS)[number];

export const POLICY_DENY_REASONS = [
  "forbidden_path",
  "path_not_allowlisted",
  "command_not_allowlisted",
  "invalid_argument",
  "cwd_not_allowlisted",
  "timeout"
] as const;

export type PolicyDenyReason = (typeof POLICY_DENY_REASONS)[number];

export const AGENT_PROFILES = [
  "builder",
  "researcher",
  "debugger",
  "documenter",
  "content",
  "lead_scraper",
  "lead_strategist"
  ,
  "ops"
] as const;

export type AgentProfile = (typeof AGENT_PROFILES)[number];

export const AGENT_TRUST_TIERS = [
  "unrestricted",
  "standard",
  "restricted",
  "probation",
  "scraper"
] as const;

export type AgentTrustTier = (typeof AGENT_TRUST_TIERS)[number];

export type AgentTrustTierPolicy = {
  requiresApproval: boolean;
  maxRuntimeMinutes: number;
  maxToolCalls: number;
  networkAccess: boolean;
  installPackages: boolean;
  runTests: boolean;
  dbWrite: boolean;
};

export const DEFAULT_AGENT_TRUST_TIER_BY_PROFILE: Record<AgentProfile, AgentTrustTier> = {
  builder: "standard",
  researcher: "restricted",
  debugger: "restricted",
  documenter: "restricted",
  lead_scraper: "scraper",
  lead_strategist: "scraper",
  ops: "scraper"
  ,
  content: "restricted"
};

export const AGENT_TRUST_TIER_POLICIES: Record<AgentTrustTier, AgentTrustTierPolicy> = {
  unrestricted: {
    requiresApproval: false,
    maxRuntimeMinutes: 45,
    maxToolCalls: 400,
    networkAccess: true,
    installPackages: true,
    runTests: true,
    dbWrite: true
  },
  standard: {
    requiresApproval: false,
    maxRuntimeMinutes: 25,
    maxToolCalls: 200,
    networkAccess: false,
    installPackages: false,
    runTests: true,
    dbWrite: true
  },
  restricted: {
    requiresApproval: false,
    maxRuntimeMinutes: 18,
    maxToolCalls: 90,
    networkAccess: false,
    installPackages: false,
    runTests: true,
    dbWrite: false
  },
  probation: {
    requiresApproval: true,
    maxRuntimeMinutes: 10,
    maxToolCalls: 40,
    networkAccess: false,
    installPackages: false,
    runTests: true,
    dbWrite: false
  },
  scraper: {
    requiresApproval: false,
    maxRuntimeMinutes: 20,
    maxToolCalls: 120,
    networkAccess: true,
    installPackages: false,
    runTests: true,
    dbWrite: false
  }
};

export const RETRY_DISPOSITIONS = [
  "not_needed",
  "scheduled",
  "exhausted"
] as const;

export type RetryDisposition = (typeof RETRY_DISPOSITIONS)[number];

export const EVALUATION_OUTCOMES = ["passed", "failed", "hard_failed"] as const;

export type EvaluationOutcome = (typeof EVALUATION_OUTCOMES)[number];

export type AgentProfileDefinition = {
  displayName: string;
  description: string;
  prompt: string;
  skillHints: string[];
  contractDefaults: {
    category: ContractCategory;
    capabilities: {
      filesystem_read: boolean;
      filesystem_write: boolean;
      run_tests: boolean;
      install_packages: boolean;
      network_access: boolean;
      db_read: boolean;
      db_write: boolean;
    };
    constraints: {
      max_runtime_minutes: number;
      max_tool_calls: number;
      max_total_input_tokens: number;
      max_total_output_tokens: number;
      max_total_cost_usd: number;
      forbidden_paths?: string[];
    };
    successCriteriaNote?: string;
  };
};

export const AGENT_PROFILE_DEFINITIONS: Record<AgentProfile, AgentProfileDefinition> = {
  builder: {
    displayName: "Builder",
    description: "Executes product/feature work with broad filesystem access and developer tooling.",
    prompt:
      "You are the Builder agent. Balance deliverables, tests, and documentation while honoring the runtime contract, dependencies, and policy checks.",
    skillHints: ["search_codebase", "run_test_suite", "scaffold_module"],
    contractDefaults: {
      category: "general",
      capabilities: {
        filesystem_read: true,
        filesystem_write: true,
        run_tests: true,
        install_packages: true,
        network_access: true,
        db_read: true,
        db_write: true
      },
      constraints: {
        max_runtime_minutes: 30,
        max_tool_calls: 200,
        max_total_input_tokens: 120_000,
        max_total_output_tokens: 40_000,
        max_total_cost_usd: 6
      }
    }
  },
  researcher: {
    displayName: "Researcher",
    description: "Digests data, synthesizes insights, and publishes research-backed learnings.",
    prompt:
      "You are the Researcher agent focused on collecting evidence, logging experiments, and turning findings into actionable memories.",
    skillHints: ["search_codebase", "run_test_suite"],
    contractDefaults: {
      category: "quality",
      capabilities: {
        filesystem_read: true,
        filesystem_write: false,
        run_tests: true,
        install_packages: false,
        network_access: true,
        db_read: true,
        db_write: false
      },
      constraints: {
        max_runtime_minutes: 20,
        max_tool_calls: 120,
        max_total_input_tokens: 80_000,
        max_total_output_tokens: 24_000,
        max_total_cost_usd: 4
      }
    }
  },
  debugger: {
    displayName: "Debugger",
    description: "Investigates bugs and runtime issues with focused reproducibility.",
    prompt:
      "You are the Debugger agent. Capture failing traces, isolate regressions, and document how to prevent them while respecting runtime contracts.",
    skillHints: ["search_codebase", "run_test_suite"],
    contractDefaults: {
      category: "debug",
      capabilities: {
        filesystem_read: true,
        filesystem_write: false,
        run_tests: true,
        install_packages: false,
        network_access: true,
        db_read: true,
        db_write: false
      },
      constraints: {
        max_runtime_minutes: 18,
        max_tool_calls: 120,
        max_total_input_tokens: 70_000,
        max_total_output_tokens: 20_000,
        max_total_cost_usd: 3.5
      }
    }
  },
  documenter: {
    displayName: "Documenter",
    description: "Writes clear documentation and knowledge artifacts based on run history.",
    prompt:
      "You are the Documenter agent. Translate technical decisions into structured docs with citations from the workspace and run history.",
    skillHints: ["search_codebase"],
      contractDefaults: {
        category: "documentation",
        capabilities: {
          filesystem_read: true,
          filesystem_write: true,
          run_tests: false,
          install_packages: false,
          network_access: true,
          db_read: true,
          db_write: false
        },
        constraints: {
          max_runtime_minutes: 20,
          max_tool_calls: 100,
          max_total_input_tokens: 60_000,
          max_total_output_tokens: 18_000,
          max_total_cost_usd: 3
        }
      }
    },
  content: {
    displayName: "Content",
    description:
      "Synthesizes documentation and communications with citations, clarity, and structured outputs.",
    prompt:
      "You are the Content agent. Turn research, run history, and findings into polished docs, reports, or narratives with explicit action steps, keeping artifacts well-scoped to the workspace and runtime policy.",
    skillHints: ["search_codebase"],
    contractDefaults: {
      category: "documentation",
      capabilities: {
        filesystem_read: true,
        filesystem_write: true,
        run_tests: false,
        install_packages: false,
        network_access: true,
        db_read: true,
        db_write: false
      },
      constraints: {
        max_runtime_minutes: 18,
        max_tool_calls: 90,
        max_total_input_tokens: 60_000,
        max_total_output_tokens: 18_000,
        max_total_cost_usd: 3
      },
      successCriteriaNote: "Deliver structured docs with citations and clear next steps."
    }
  },
  lead_scraper: {
    displayName: "Lead Scraper",
    description:
      "Runs the DFW lead scraping workflow, prioritizing HVAC and professional services opportunities with safe access to Sheets and HTTP adapters.",
    prompt:
      "You are the Lead Scraper agent. Discover qualified HVAC/professional-services leads across the DFW metroplex. Prioritize exact data collection, deduplicate results, and keep all writes limited to the orchestrated Google Sheet or HTTP endpoints. Never write directly to the filesystem.",
    skillHints: ["search_codebase", "expand_zones"],
    contractDefaults: {
      category: "integration",
      capabilities: {
        filesystem_read: false,
        filesystem_write: false,
        run_tests: false,
        install_packages: false,
        network_access: true,
        db_read: true,
        db_write: false
      },
      constraints: {
        max_runtime_minutes: 18,
        max_tool_calls: 100,
        max_total_input_tokens: 45_000,
        max_total_output_tokens: 12_000,
        max_total_cost_usd: 2,
        forbidden_paths: ["/etc", "/usr/local/bin"]
      },
      successCriteriaNote:
        "Deliver structured lead rows and persistence proof in the configured Google Sheet every time."
    }
  },
  lead_strategist: {
    displayName: "Lead Strategist",
    description:
      "Scores HVAC/professional-services leads, defines qualification tiers, and enriches outreach-ready data via the approved connectors.",
    prompt:
      "You are the Lead Strategist agent. Score each DFW HVAC/professional-services lead, document tiered qualification criteria, enrich the approved spreadsheet or HTTP endpoint, and keep all runtime work within the policy bounds.",
    skillHints: ["search_codebase", "expand_zones"],
    contractDefaults: {
      category: "operations",
      capabilities: {
        filesystem_read: false,
        filesystem_write: false,
        run_tests: false,
        install_packages: false,
        network_access: true,
        db_read: true,
        db_write: false
      },
      constraints: {
        max_runtime_minutes: 22,
        max_tool_calls: 140,
        max_total_input_tokens: 55_000,
        max_total_output_tokens: 16_000,
        max_total_cost_usd: 2.5,
        forbidden_paths: ["/etc", "/usr/local/bin"]
      },
      successCriteriaNote:
        "Output tiered scores, enrichment metadata, and outreach-ready fields for every lead you process."
    }
  },
  ops: {
    displayName: "Ops",
    description:
      "Monitors daemon health, surfaces incidents, and reports anomalies with conservative tooling.",
    prompt:
      "You are the Ops agent. Continuously check daemon heartbeats, evaluate run history, and escalate issues with clear evidence while respecting the runtime contract. Favor read-only insights, HTTP queries, and avoid filesystem writes.",
    skillHints: ["search_codebase"],
    contractDefaults: {
      category: "operations",
      capabilities: {
        filesystem_read: true,
        filesystem_write: false,
        run_tests: false,
        install_packages: false,
        network_access: true,
        db_read: true,
        db_write: false
      },
      constraints: {
        max_runtime_minutes: 15,
        max_tool_calls: 80,
        max_total_input_tokens: 35_000,
        max_total_output_tokens: 10_000,
        max_total_cost_usd: 1.5,
        forbidden_paths: ["/etc", "/usr/local/bin"]
      },
      successCriteriaNote:
        "Report daemon/run health states and policy anomalies with timestamped context and mitigation suggestions."
    }
  }
};

export const RUN_EVENT_TYPES = [
  "run.started",
  "run.heartbeat",
  "plan.generated",
  "tool.called",
  "tool.result",
  "usage.reported",
  "policy.denied",
  "resource.limit_reached",
  "artifact.created",
  "roadblock.detected",
  "run.cancel_requested",
  "run.resumed",
  "evaluation.completed",
  "run.retry_requested",
  "run.final_payload",
  "run.completed",
  "run.cancelled",
  "run.failed"
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const RUN_EVENT_LEVELS = ["debug", "info", "warn", "error"] as const;

export type RunEventLevel = (typeof RUN_EVENT_LEVELS)[number];

export type TaskId = string;
export type ContractId = string;
export type RunId = string;
export type WorkspaceId = string;

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["planning", "cancelled"],
  planning: ["running", "blocked", "failed", "cancelled", "needs_review"],
  running: ["completed", "blocked", "failed", "needs_review", "cancelled"],
  blocked: ["queued", "running", "failed", "needs_review", "cancelled"],
  completed: [],
  failed: ["queued", "cancelled"],
  needs_review: ["queued", "running", "completed", "failed", "cancelled"],
  cancelled: ["queued"]
};

const CONTRACT_TRANSITIONS: Record<ContractStatus, readonly ContractStatus[]> = {
  draft: ["approved", "superseded", "closed"],
  approved: ["active", "superseded", "closed"],
  active: ["superseded", "closed"],
  superseded: [],
  closed: []
};

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  created: ["provisioning", "starting", "cancelled", "failed"],
  provisioning: ["starting", "failed", "cancelled", "blocked"],
  starting: ["running", "failed", "cancelled", "blocked"],
  running: ["evaluating", "failed", "blocked", "cancelled", "completed"],
  evaluating: ["completed", "failed", "blocked"],
  completed: [],
  failed: [],
  blocked: [],
  cancelled: []
};

function assertTransition<T extends string>(
  current: T,
  next: T,
  allowedMap: Record<T, readonly T[]>,
  stateName: string
): void {
  if (current === next) {
    return;
  }

  const allowed = allowedMap[current] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(`Invalid ${stateName} transition: ${current} -> ${next}`);
  }
}

export function assertTaskTransition(current: TaskStatus, next: TaskStatus): void {
  assertTransition(current, next, TASK_TRANSITIONS, "task");
}

export function assertContractTransition(
  current: ContractStatus,
  next: ContractStatus
): void {
  assertTransition(current, next, CONTRACT_TRANSITIONS, "contract");
}

export function assertRunTransition(current: RunStatus, next: RunStatus): void {
  assertTransition(current, next, RUN_TRANSITIONS, "run");
}

export function isTerminalRunStatus(status: RunStatus): status is TerminalRunStatus {
  return TERMINAL_RUN_STATUSES.includes(status as TerminalRunStatus);
}
