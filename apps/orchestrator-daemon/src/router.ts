import type { AgentProfile, ContractCategory } from "@salvo/shared";
import { AGENT_PROFILE_DEFINITIONS } from "@salvo/shared";

type AgentCapabilityKey = keyof (typeof AGENT_PROFILE_DEFINITIONS)["builder"]["contractDefaults"]["capabilities"];

export type ProfileHistoryEntry = {
  profile: AgentProfile;
  successRate: number;
  runCount?: number;
  averageScore?: number;
  averageCostUsd?: number;
  matchScope?: "family" | "category";
};

export type ProfileRoutingInput = {
  preferredProfile?: AgentProfile;
  plannedProfile?: AgentProfile;
  contractCategory?: ContractCategory;
  contractCapabilities?: Partial<Record<AgentCapabilityKey, boolean>>;
  taskPriority?: number;
  taskTitle?: string;
  history?: ProfileHistoryEntry[];
};

export type ProfileRoutingCandidate = {
  profile: AgentProfile;
  score: number;
  reasons: string[];
};

export type ProfileRoutingResult = {
  selectedProfile: AgentProfile;
  rankedCandidates: ProfileRoutingCandidate[];
  reasoning: string;
};

const PRIORITY_BIAS_BY_CATEGORY: Record<ContractCategory, number> = {
  general: 1.2,
  integration: 1,
  migration: 0.9,
  debug: 1.1,
  quality: 0.9,
  documentation: 0.8,
  operations: 1
};

const KEYWORD_PROFILE_HINTS: Array<{
  regex: RegExp;
  profile: AgentProfile;
  boost: number;
  reason: string;
}> = [
  {
    regex: /\blead(er)?s?\b/,
    profile: "lead_scraper",
    boost: 6,
    reason: "title mentions lead generation"
  },
  {
    regex: /\bstrategist\b/,
    profile: "lead_strategist",
    boost: 6,
    reason: "title mentions lead strategy"
  },
  {
    regex: /\bresearch(ing)?\b/,
    profile: "researcher",
    boost: 5,
    reason: "title hints at research work"
  },
  {
    regex: /\b(debug|bug|fix|investigate)\b/,
    profile: "debugger",
    boost: 5,
    reason: "title looks like debugging"
  },
  {
    regex: /\bdocument|doc(s)?\b/,
    profile: "documenter",
    boost: 4,
    reason: "title asks for documentation"
  },
  {
    regex: /\bcontent\b/,
    profile: "content",
    boost: 4,
    reason: "title mentioned content creation"
  }
];

function normalizePriority(value?: number): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  return Math.min(10, Math.max(0, value));
}

function buildKeywordBoostMap(text: string) {
  const hintMap = new Map<AgentProfile, { boost: number; reason: string }>();
  const lowered = text.toLowerCase();
  for (const hint of KEYWORD_PROFILE_HINTS) {
    if (!hintMap.has(hint.profile) && hint.regex.test(lowered)) {
      hintMap.set(hint.profile, { boost: hint.boost, reason: hint.reason });
    }
  }
  return hintMap;
}

function satisfiesCapabilities(
  definition: (typeof AGENT_PROFILE_DEFINITIONS)[AgentProfile],
  requirements: Partial<Record<AgentCapabilityKey, boolean>>
): boolean {
  for (const [capability, required] of Object.entries(requirements)) {
    if (required) {
      const key = capability as AgentCapabilityKey;
      if (!definition.contractDefaults.capabilities[key]) {
        return false;
      }
    }
  }
  return true;
}

function scoreProfileCandidate(
  profile: AgentProfile,
  definition: (typeof AGENT_PROFILE_DEFINITIONS)[AgentProfile],
  input: ProfileRoutingInput,
  options?: { normalizedPriority?: number; keywordBoosts?: Map<AgentProfile, { boost: number; reason: string }>; ignoreCapabilityCheck?: boolean }
): ProfileRoutingCandidate | null {
  const requirements = input.contractCapabilities ?? {};
  if (!options?.ignoreCapabilityCheck && Object.keys(requirements).length > 0) {
    if (!satisfiesCapabilities(definition, requirements)) {
      return null;
    }
  }

  const reasons: string[] = [];
  let score = 0;

  if (Object.keys(requirements).length > 0) {
    reasons.push("satisfies required capabilities");
  }

  if (input.preferredProfile && input.preferredProfile === profile) {
    score += 16;
    reasons.push("preferred profile requested");
  }

  if (input.plannedProfile && input.plannedProfile === profile && input.preferredProfile !== profile) {
    score += 8;
    reasons.push("planner selected this profile");
  }

  if (input.contractCategory) {
    if (definition.contractDefaults.category === input.contractCategory) {
      score += 12;
      reasons.push(`natural fit for ${input.contractCategory} category`);
    }
  }

  const priority = options?.normalizedPriority ?? normalizePriority(input.taskPriority);
  if (priority !== undefined) {
    const bias = PRIORITY_BIAS_BY_CATEGORY[definition.contractDefaults.category] ?? 1;
    const priorityScore = (priority / 10) * (3 + bias);
    score += priorityScore;
    reasons.push(`task priority ${priority.toFixed(1)}/10`);
  }

  const keywordHint = options?.keywordBoosts?.get(profile);
  if (keywordHint) {
    score += keywordHint.boost;
    reasons.push(keywordHint.reason);
  }

  const historyEntry = input.history?.find((entry) => entry.profile === profile);
  if (historyEntry) {
    const success = Math.min(1, Math.max(0, historyEntry.successRate));
    score += success * 8;
    reasons.push(
      `${historyEntry.matchScope ?? "recent"} history ${Math.round(success * 100)}% success rate`
    );
    if (historyEntry.runCount && historyEntry.runCount > 0) {
      const boost = Math.log2(historyEntry.runCount + 1);
      score += boost;
      reasons.push(`based on ${historyEntry.runCount} recent runs`);
    }
    if (typeof historyEntry.averageScore === "number") {
      score += Math.min(6, Math.max(0, historyEntry.averageScore / 20));
      reasons.push(`avg score ${Math.round(historyEntry.averageScore)}`);
    }
    if (typeof historyEntry.averageCostUsd === "number") {
      score -= Math.min(4, Math.max(0, historyEntry.averageCostUsd * 2));
      reasons.push(`avg cost $${historyEntry.averageCostUsd.toFixed(2)}`);
    }
  }

  return {
    profile,
    score,
    reasons
  };
}

export function routeAgentProfiles(input: ProfileRoutingInput): ProfileRoutingResult {
  const normalizedPriority = normalizePriority(input.taskPriority);
  const textHintSource = [input.taskTitle, input.contractCategory].filter(Boolean).join(" ");
  const keywordBoosts = buildKeywordBoostMap(textHintSource);

  const candidateProfiles = Object.entries(AGENT_PROFILE_DEFINITIONS) as [AgentProfile, typeof AGENT_PROFILE_DEFINITIONS[AgentProfile]][];
  const scoredCandidates = candidateProfiles
    .map(([profile, definition]) =>
      scoreProfileCandidate(profile, definition, input, {
        normalizedPriority,
        keywordBoosts
      })
    )
    .filter((candidate): candidate is ProfileRoutingCandidate => candidate !== null);

  const finalCandidates =
    scoredCandidates.length > 0
      ? scoredCandidates
      : [
          scoreProfileCandidate(
            "builder",
            AGENT_PROFILE_DEFINITIONS.builder,
            input,
            {
              normalizedPriority,
              keywordBoosts,
              ignoreCapabilityCheck: true
            }
          )!
        ];

  const rankedCandidates = [...finalCandidates].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.profile.localeCompare(b.profile);
  });

  const selected = rankedCandidates[0];
  const reasoning =
    selected.reasons.length > 0
      ? `Selected ${selected.profile} because ${selected.reasons.join("; ")}`
      : `Selected ${selected.profile} by default heuristics.`;

  return {
    selectedProfile: selected.profile,
    rankedCandidates,
    reasoning
  };
}
