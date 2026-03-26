import type { ContractAssertion } from "@salvo/contracts";
import type { EvaluationOutcome } from "@salvo/shared";

export const EVALUATION_WEIGHTS = {
  contract_compliance: 35,
  tests: 30,
  deliverables: 20,
  evidence: 10,
  learnings: 5
} as const;

export type EvaluationInput = {
  contractCompliance?: number;
  testsExitCode?: number;
  testsRun?: ReadonlyArray<{ command?: string; exit_code?: number; denied?: boolean }>;
  requiredTestCommands?: readonly string[];
  requiredAssertions?: readonly ContractAssertion[];
  finalPayloadPresent?: boolean;
  requiredDeliverables: readonly string[];
  producedDeliverables: readonly string[];
  evidencePresent: boolean;
  learningsCount: number;
  policyDeniedCount: number;
  artifacts?: ReadonlyArray<{
    path: string;
    content?: string;
    artifactType?: string;
  }>;
  commandResults?: ReadonlyArray<{
    command?: string;
    exit_code?: number;
    denied?: boolean;
  }>;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxTotalTokens?: number;
    maxCostUsd?: number;
  };
};

export type EvaluationResult = {
  outcome: EvaluationOutcome;
  passed: boolean;
  score: number;
  hardFailReason?: string;
  findings: string[];
};

type AssertionEvaluation = {
  assertion: string;
  recognized: boolean;
  passed: boolean;
};

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function matchesArtifactPath(actualPath: string, expectedPath: string): boolean {
  const normalizedActual = normalizePath(actualPath).toLowerCase();
  const normalizedExpected = normalizePath(expectedPath).toLowerCase();
  return (
    normalizedActual === normalizedExpected ||
    normalizedActual.endsWith(`/${normalizedExpected}`) ||
    normalizedActual.endsWith(normalizedExpected)
  );
}

function readArtifactContent(
  artifacts: ReadonlyArray<{ path: string; content?: string }>
  , targetPath: string
): string | undefined {
  const match = artifacts.find((artifact) => matchesArtifactPath(artifact.path, targetPath));
  return match?.content;
}

function evaluateStructuredAssertion(
  assertion: ContractAssertion,
  input: EvaluationInput
): AssertionEvaluation {
  if (typeof assertion === "string") {
    if (assertion === "Runner emits a final payload event.") {
      return {
        assertion,
        recognized: true,
        passed: Boolean(input.finalPayloadPresent)
      };
    }

    if (assertion === "At least one deliverable produced.") {
      return {
        assertion,
        recognized: true,
        passed: input.producedDeliverables.length > 0
      };
    }

    return {
      assertion,
      recognized: false,
      passed: true
    };
  }

  if (assertion.type === "final_payload_present") {
    return {
      assertion: "final_payload_present",
      recognized: true,
      passed: Boolean(input.finalPayloadPresent)
    };
  }

  if (assertion.type === "artifact_exists") {
    const artifact = input.artifacts?.find((candidate) =>
      matchesArtifactPath(candidate.path, assertion.path)
    );
    const artifactTypeMatches =
      !assertion.artifact_type ||
      artifact?.artifactType === assertion.artifact_type ||
      artifact?.artifactType?.toLowerCase() === assertion.artifact_type.toLowerCase();
    return {
      assertion: `artifact_exists:${assertion.path}`,
      recognized: true,
      passed: Boolean(artifact) && artifactTypeMatches
    };
  }

  if (assertion.type === "artifact_contains") {
    const artifactContent = readArtifactContent(input.artifacts ?? [], assertion.path);
    if (artifactContent === undefined) {
      return {
        assertion: `artifact_contains:${assertion.path}`,
        recognized: true,
        passed: false
      };
    }

    const haystack = assertion.case_sensitive ? artifactContent : artifactContent.toLowerCase();
    const needle = assertion.case_sensitive ? assertion.text : assertion.text.toLowerCase();
    return {
      assertion: `artifact_contains:${assertion.path}`,
      recognized: true,
      passed: haystack.includes(needle)
    };
  }

  if (assertion.type === "command_exit_code") {
    const commandResult = input.commandResults?.find(
      (candidate) => candidate.command === assertion.command
    );
    const passed =
      commandResult !== undefined &&
      commandResult.denied !== true &&
      commandResult.exit_code === assertion.exit_code;
    return {
      assertion: `command_exit_code:${assertion.command}`,
      recognized: true,
      passed
    };
  }

  if (assertion.type === "token_budget") {
    const usage = input.tokenUsage;
    if (!usage) {
      return {
        assertion: "token_budget",
        recognized: true,
        passed: true
      };
    }

    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;
    const withinInput =
      assertion.max_input_tokens === undefined || inputTokens <= assertion.max_input_tokens;
    const withinOutput =
      assertion.max_output_tokens === undefined || outputTokens <= assertion.max_output_tokens;
    const withinTotal =
      assertion.max_total_tokens === undefined || totalTokens <= assertion.max_total_tokens;
    const withinCost =
      assertion.max_cost_usd === undefined ||
      usage.costUsd === undefined ||
      usage.costUsd <= assertion.max_cost_usd;
    return {
      assertion: "token_budget",
      recognized: true,
      passed: withinInput && withinOutput && withinTotal && withinCost
    };
  }

  return {
    assertion: JSON.stringify(assertion),
    recognized: false,
    passed: true
  };
}

function evaluateAssertions(input: EvaluationInput): AssertionEvaluation[] {
  const results: AssertionEvaluation[] = [];
  for (const assertion of input.requiredAssertions ?? []) {
    results.push(evaluateStructuredAssertion(assertion, input));
  }

  return results;
}

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

  const requiredTests = input.requiredTestCommands ?? [];
  const testsRun = input.testsRun ?? [];
  for (const requiredTest of requiredTests) {
    const match = testsRun.find((entry) => entry.command === requiredTest);
    if (!match) {
      return {
        outcome: "hard_failed",
        passed: false,
        score: 0,
        hardFailReason: "Required test command missing.",
        findings: [`Hard fail: required test command not executed (${requiredTest}).`]
      };
    }

    if (match.denied || match.exit_code !== 0) {
      return {
        outcome: "hard_failed",
        passed: false,
        score: 0,
        hardFailReason: "Required test command failed.",
        findings: [`Hard fail: required test command failed (${requiredTest}).`]
      };
    }
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

  const assertionResults = evaluateAssertions(input);
  const failedAssertions = assertionResults.filter((result) => result.recognized && !result.passed);
  findings.push(...failedAssertions.map((result) => `Assertion failed: ${result.assertion}`));
  const skippedAssertions = assertionResults.filter((result) => !result.recognized);
  findings.push(...skippedAssertions.map((result) => `Assertion not recognized and skipped: ${result.assertion}`));

  const tokenUsage = input.tokenUsage;
  if (tokenUsage) {
    const inputTokens = tokenUsage.inputTokens ?? 0;
    const outputTokens = tokenUsage.outputTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;

    if (tokenUsage.maxInputTokens !== undefined && inputTokens > tokenUsage.maxInputTokens) {
      return {
        outcome: "hard_failed",
        passed: false,
        score: 0,
        hardFailReason: "Input token budget exceeded.",
        findings: [
          `Hard fail: input token budget exceeded (${inputTokens} > ${tokenUsage.maxInputTokens}).`
        ]
      };
    }

    if (tokenUsage.maxOutputTokens !== undefined && outputTokens > tokenUsage.maxOutputTokens) {
      return {
        outcome: "hard_failed",
        passed: false,
        score: 0,
        hardFailReason: "Output token budget exceeded.",
        findings: [
          `Hard fail: output token budget exceeded (${outputTokens} > ${tokenUsage.maxOutputTokens}).`
        ]
      };
    }

    if (tokenUsage.maxTotalTokens !== undefined && totalTokens > tokenUsage.maxTotalTokens) {
      return {
        outcome: "hard_failed",
        passed: false,
        score: 0,
        hardFailReason: "Total token budget exceeded.",
        findings: [
          `Hard fail: total token budget exceeded (${totalTokens} > ${tokenUsage.maxTotalTokens}).`
        ]
      };
    }

    if (tokenUsage.maxCostUsd !== undefined && tokenUsage.costUsd !== undefined) {
      if (tokenUsage.costUsd > tokenUsage.maxCostUsd) {
        return {
          outcome: "hard_failed",
          passed: false,
          score: 0,
          hardFailReason: "Cost budget exceeded.",
          findings: [
            `Hard fail: cost budget exceeded (${tokenUsage.costUsd} > ${tokenUsage.maxCostUsd}).`
          ]
        };
      }
    }
  }

  const recognizedResults = assertionResults.filter((result) => result.recognized);
  const satisfiedAssertions = recognizedResults.filter((result) => result.passed).length;
  const contractComplianceScore =
    recognizedResults.length === 0 ? 1 : satisfiedAssertions / recognizedResults.length;
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
