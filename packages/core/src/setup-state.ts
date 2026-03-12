export const setupStatuses = [
  "not_configured",
  "needs_auth",
  "ready",
  "error"
] as const;

export type SetupStatus = (typeof setupStatuses)[number];

export const SECTIONS = [
  "dashboard",
  "contracts",
  "fleet",
  "runs",
  "reviews",
  "policy",
  "audit",
  "integrations"
] as const;

export type SectionKey = (typeof SECTIONS)[number];

export const INTEGRATION_KEYS = [
  "supabase",
  "llm_api",
  "process",
  "http"
] as const;

export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

export type WorkflowKey = "lead_gen";

export type IntegrationDefinition = {
  key: IntegrationKey;
  label: string;
  description: string;
};

export type IntegrationState = {
  status: SetupStatus;
  detail?: string;
  updatedAt: string;
};

export type IntegrationConfigMap = {
  supabase: {
    url: string;
    anonKey: string;
  };
  llm_api: {
    provider: "anthropic" | "openai" | "custom";
    apiKey: string;
    baseUrl: string;
    defaultModel: string;
  };
  process: {
    command: string;
  };
  http: {
    baseUrl: string;
    token: string;
  };
};

export type SetupState = {
  integrations: Record<IntegrationKey, IntegrationState>;
  config: IntegrationConfigMap;
};

export type SetupTask = {
  id: string;
  title: string;
  description: string;
  status: SetupStatus;
};

export type Readiness = {
  ready: boolean;
  blockers: IntegrationKey[];
};

export type WorkflowState = Readiness & {
  workflow: WorkflowKey;
  status: "blocked" | "ready";
};

export const INTEGRATIONS: IntegrationDefinition[] = [
  {
    key: "supabase",
    label: "Supabase Postgres",
    description:
      "Primary relational store for runs, policy snapshots, and audit events."
  },
  {
    key: "llm_api",
    label: "LLM API Adapter",
    description:
      "Adapter scaffold for provider-agnostic hosted LLM execution."
  },
  {
    key: "process",
    label: "Process Adapter",
    description:
      "Adapter scaffold for local shell/process-based workloads on macOS."
  },
  {
    key: "http",
    label: "HTTP Adapter",
    description: "Adapter scaffold for remote service workflows over HTTP."
  }
];

export const SECTION_REQUIREMENTS: Record<SectionKey, IntegrationKey[]> = {
  dashboard: [],
  contracts: ["supabase", "llm_api"],
  fleet: ["supabase"],
  runs: ["process", "supabase"],
  reviews: ["llm_api"],
  policy: ["supabase"],
  audit: ["supabase"],
  integrations: []
};

const WORKFLOW_REQUIREMENTS: Record<WorkflowKey, IntegrationKey[]> = {
  lead_gen: ["supabase", "http", "llm_api"]
};

const DEFAULT_CONFIG: IntegrationConfigMap = {
  supabase: {
    url: "",
    anonKey: ""
  },
  llm_api: {
    provider: "anthropic",
    apiKey: "",
    baseUrl: "",
    defaultModel: ""
  },
  process: {
    command: ""
  },
  http: {
    baseUrl: "",
    token: ""
  }
};

function isValidUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

export function validateIntegrationConfig(
  key: IntegrationKey,
  config: IntegrationConfigMap[IntegrationKey]
): Omit<IntegrationState, "updatedAt"> {
  if (key === "supabase") {
    const details = config as IntegrationConfigMap["supabase"];

    if (!details.url || !details.anonKey) {
      return {
        status: "not_configured",
        detail: "Set Supabase URL and anon key."
      };
    }

    if (!isValidUrl(details.url)) {
      return {
        status: "error",
        detail: "Supabase URL must be a valid http/https URL."
      };
    }

    return {
      status: "ready",
      detail: "Supabase credentials are configured."
    };
  }

  if (key === "llm_api") {
    const details = config as IntegrationConfigMap["llm_api"];

    if (!details.apiKey) {
      return {
        status: "needs_auth",
        detail: "Set an LLM API key."
      };
    }

    if (details.baseUrl && !isValidUrl(details.baseUrl)) {
      return {
        status: "error",
        detail: "LLM API base URL must be a valid http/https URL."
      };
    }

    return {
      status: "ready",
      detail: "LLM API configuration is complete."
    };
  }

  if (key === "process") {
    const details = config as IntegrationConfigMap["process"];

    if (!details.command) {
      return {
        status: "not_configured",
        detail: "Set a process command for local run execution."
      };
    }

    return {
      status: "ready",
      detail: "Process command is configured."
    };
  }

  const details = config as IntegrationConfigMap["http"];

  if (!details.baseUrl) {
    return {
      status: "not_configured",
      detail: "Set an HTTP base URL."
    };
  }

  if (!isValidUrl(details.baseUrl)) {
    return {
      status: "error",
      detail: "HTTP base URL must be a valid http/https URL."
    };
  }

  if (!details.token) {
    return {
      status: "needs_auth",
      detail: "Set an HTTP bearer token."
    };
  }

  return {
    status: "ready",
    detail: "HTTP adapter configuration is complete."
  };
}

export function toIntegrationStates(
  config: IntegrationConfigMap
): Record<IntegrationKey, IntegrationState> {
  const now = new Date().toISOString();

  return {
    supabase: {
      ...validateIntegrationConfig("supabase", config.supabase),
      updatedAt: now
    },
    llm_api: {
      ...validateIntegrationConfig("llm_api", config.llm_api),
      updatedAt: now
    },
    process: {
      ...validateIntegrationConfig("process", config.process),
      updatedAt: now
    },
    http: {
      ...validateIntegrationConfig("http", config.http),
      updatedAt: now
    }
  };
}

export function createInitialSetupState(
  seed?: Partial<IntegrationConfigMap>
): SetupState {
  const mergedConfig: IntegrationConfigMap = {
    supabase: {
      ...DEFAULT_CONFIG.supabase,
      ...(seed?.supabase ?? {})
    },
    llm_api: {
      ...DEFAULT_CONFIG.llm_api,
      ...(seed?.llm_api ?? {})
    },
    process: {
      ...DEFAULT_CONFIG.process,
      ...(seed?.process ?? {})
    },
    http: {
      ...DEFAULT_CONFIG.http,
      ...(seed?.http ?? {})
    }
  };

  return {
    config: mergedConfig,
    integrations: toIntegrationStates(mergedConfig)
  };
}

export const DEFAULT_SETUP_STATE = createInitialSetupState();

export function integrationLabel(key: IntegrationKey): string {
  const integration = INTEGRATIONS.find((item) => item.key === key);
  return integration ? integration.label : key;
}

export function withUpdatedIntegrationConfig(
  state: SetupState,
  key: IntegrationKey,
  config: Partial<IntegrationConfigMap[IntegrationKey]>
): SetupState {
  const nextConfig: IntegrationConfigMap = {
    ...state.config,
    [key]: {
      ...state.config[key],
      ...config
    }
  };

  return {
    config: nextConfig,
    integrations: toIntegrationStates(nextConfig)
  };
}

export function recomputeSetupState(state: SetupState): SetupState {
  return {
    ...state,
    integrations: toIntegrationStates(state.config)
  };
}

export function resolveSectionReadiness(
  state: SetupState,
  section: SectionKey
): Readiness {
  const requirements = SECTION_REQUIREMENTS[section];
  const blockers = requirements.filter(
    (key) => state.integrations[key].status !== "ready"
  );

  return {
    ready: blockers.length === 0,
    blockers
  };
}

export function resolveWorkflowState(
  state: SetupState,
  workflow: WorkflowKey
): WorkflowState {
  const blockers = WORKFLOW_REQUIREMENTS[workflow].filter(
    (key) => state.integrations[key].status !== "ready"
  );

  return {
    workflow,
    ready: blockers.length === 0,
    blockers,
    status: blockers.length === 0 ? "ready" : "blocked"
  };
}

export function buildSetupTasks(state: SetupState): SetupTask[] {
  return INTEGRATIONS.flatMap((integration) => {
    const setup = state.integrations[integration.key];
    if (setup.status === "ready") {
      return [];
    }

    const descriptions: Record<SetupStatus, string> = {
      not_configured: "Configuration is missing.",
      needs_auth: "Authentication must be completed.",
      error: "Integration has an error that needs intervention.",
      ready: "Integration is configured."
    };

    return [
      {
        id: `integration-${integration.key}`,
        title: `${integration.label} setup`,
        description: setup.detail ?? descriptions[setup.status],
        status: setup.status
      }
    ];
  });
}
