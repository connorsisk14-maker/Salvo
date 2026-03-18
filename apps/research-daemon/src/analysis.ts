export type ExperimentSample = {
  run_id: string;
  run_status: "completed" | "failed";
  evaluation_outcome: "passed" | "failed" | "hard_failed";
  score: number;
  policy_denial_count: number;
  event_count: number;
};

export type ExperimentMetrics = {
  sample_size: number;
  completed_count: number;
  failed_count: number;
  pass_rate: number;
  average_score: number;
  policy_denial_rate: number;
  average_event_count: number;
  evaluation: {
    passed: number;
    failed: number;
    hard_failed: number;
  };
};

function toFixedNumber(value: number, places = 4): number {
  return Number(value.toFixed(places));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function normalizeExperimentSamples(
  input: ReadonlyArray<ExperimentSample>
): ExperimentSample[] {
  return [...input].sort((a, b) => a.run_id.localeCompare(b.run_id));
}

export function deriveExperimentMetrics(
  input: ReadonlyArray<ExperimentSample>
): ExperimentMetrics {
  const samples = normalizeExperimentSamples(input);
  const total = samples.length;
  if (total === 0) {
    return {
      sample_size: 0,
      completed_count: 0,
      failed_count: 0,
      pass_rate: 0,
      average_score: 0,
      policy_denial_rate: 0,
      average_event_count: 0,
      evaluation: {
        passed: 0,
        failed: 0,
        hard_failed: 0
      }
    };
  }

  const completedCount = samples.filter((item) => item.run_status === "completed").length;
  const failedCount = total - completedCount;
  const passedCount = samples.filter((item) => item.evaluation_outcome === "passed").length;
  const evaluationFailedCount = samples.filter((item) => item.evaluation_outcome === "failed").length;
  const hardFailedCount = samples.filter((item) => item.evaluation_outcome === "hard_failed").length;
  const avgScore = samples.reduce((sum, item) => sum + item.score, 0) / total;
  const policyDeniedRuns = samples.filter((item) => item.policy_denial_count > 0).length;
  const avgEventCount = samples.reduce((sum, item) => sum + item.event_count, 0) / total;

  return {
    sample_size: total,
    completed_count: completedCount,
    failed_count: failedCount,
    pass_rate: toFixedNumber(passedCount / total),
    average_score: toFixedNumber(avgScore, 2),
    policy_denial_rate: toFixedNumber(policyDeniedRuns / total),
    average_event_count: toFixedNumber(avgEventCount, 2),
    evaluation: {
      passed: passedCount,
      failed: evaluationFailedCount,
      hard_failed: hardFailedCount
    }
  };
}

export function deriveExperimentConfidence(metrics: ExperimentMetrics): number {
  const rawScore =
    0.45 * metrics.pass_rate +
    0.35 * (metrics.average_score / 100) +
    0.2 * (1 - metrics.policy_denial_rate);
  return toFixedNumber(clamp01(rawScore), 2);
}

export function buildExperimentMarkdown(input: {
  familyKey: string;
  category: string;
  subcategory: string | null;
  metrics: ExperimentMetrics;
}): string {
  return [
    `# Experiment Report: ${input.category}${input.subcategory ? `/${input.subcategory}` : ""}`,
    "",
    `- Family Key: ${input.familyKey}`,
    `- Sample Size: ${input.metrics.sample_size}`,
    `- Completed Runs: ${input.metrics.completed_count}`,
    `- Failed Runs: ${input.metrics.failed_count}`,
    "",
    "## Evaluation Outcomes",
    `- Passed: ${input.metrics.evaluation.passed}`,
    `- Failed: ${input.metrics.evaluation.failed}`,
    `- Hard Failed: ${input.metrics.evaluation.hard_failed}`,
    "",
    "## Deterministic Metrics",
    `- Pass Rate: ${toFixedNumber(input.metrics.pass_rate * 100, 2)}%`,
    `- Average Score: ${toFixedNumber(input.metrics.average_score, 2)}`,
    `- Policy Denial Rate: ${toFixedNumber(input.metrics.policy_denial_rate * 100, 2)}%`,
    `- Average Event Count: ${toFixedNumber(input.metrics.average_event_count, 2)}`
  ].join("\n");
}
