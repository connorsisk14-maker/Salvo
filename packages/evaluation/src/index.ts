import type { EvaluationOutcome } from "@salvo/shared";

export const EVALUATION_WEIGHTS = {
  contract_compliance: 35,
  tests: 30,
  deliverables: 20,
  evidence: 10,
  learnings: 5
} as const;

export type EvaluationInput = {
  contractCompliance: number;
  testsExitCode?: number;
  requiredDeliverables: readonly string[];
  producedDeliverables: readonly string[];
  evidencePresent: boolean;
  learningsCount: number;
  policyDeniedCount: number;
};

export type EvaluationResult = {
  outcome: EvaluationOutcome;
  passed: boolean;
  score: number;
  hardFailReason?: string;
  findings: string[];
};

function clampScore(input: number): number {
  if (input < 0) {
    return 0;
  }
  if (input > 100) {
    return 100;
  }
  return Math.round(input);
}

export function evaluateRun(input: EvaluationInput): EvaluationResult {
  const findings: string[] = [];

  if (input.policyDeniedCount > 0) {
    return {
      outcome: "hard_failed",
      passed: false,
      score: 0,
      hardFailReason: "Policy denial occurred during run.",
      findings: ["Hard fail: policy.denied event observed."]
    };
  }

  const missingDeliverables = input.requiredDeliverables.filter(
    (item) => !input.producedDeliverables.includes(item)
  );

  if (missingDeliverables.length > 0) {
    return {
      outcome: "hard_failed",
      passed: false,
      score: 0,
      hardFailReason: "Missing required deliverables.",
      findings: missingDeliverables.map((item) => `Missing deliverable: ${item}`)
    };
  }

  if (input.testsExitCode !== undefined && input.testsExitCode !== 0) {
    return {
      outcome: "hard_failed",
      passed: false,
      score: 0,
      hardFailReason: "Required test command failed.",
      findings: ["Hard fail: required test command exited non-zero."]
    };
  }

  const contractComplianceScore = clampScore(input.contractCompliance) / 100;
  const testsScore = input.testsExitCode === 0 || input.testsExitCode === undefined ? 1 : 0;
  const deliverablesScore = 1;
  const evidenceScore = input.evidencePresent ? 1 : 0;
  const learningsScore = input.learningsCount > 0 ? 1 : 0;

  const weightedScore =
    contractComplianceScore * EVALUATION_WEIGHTS.contract_compliance +
    testsScore * EVALUATION_WEIGHTS.tests +
    deliverablesScore * EVALUATION_WEIGHTS.deliverables +
    evidenceScore * EVALUATION_WEIGHTS.evidence +
    learningsScore * EVALUATION_WEIGHTS.learnings;

  const score = clampScore(weightedScore);
  const passed = score >= 80;

  if (!input.evidencePresent) {
    findings.push("Evidence block missing from final payload.");
  }
  if (input.learningsCount === 0) {
    findings.push("No learnings captured.");
  }

  return {
    outcome: passed ? "passed" : "failed",
    passed,
    score,
    findings
  };
}
