import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildExperimentMarkdown,
  deriveExperimentConfidence,
  deriveExperimentInsights,
  deriveExperimentMetrics
} from "../src/analysis";

const sample = [
  {
    run_id: "run-b",
    run_status: "failed" as const,
    evaluation_outcome: "failed" as const,
    score: 42,
    policy_denial_count: 1,
    event_count: 11
  },
  {
    run_id: "run-a",
    run_status: "completed" as const,
    evaluation_outcome: "passed" as const,
    score: 91,
    policy_denial_count: 0,
    event_count: 8
  }
];

test("experiment metrics are deterministic for the same payload", () => {
  const first = deriveExperimentMetrics(sample);
  const second = deriveExperimentMetrics([...sample].reverse());
  assert.deepEqual(first, second);

  const firstConfidence = deriveExperimentConfidence(first);
  const secondConfidence = deriveExperimentConfidence(second);
  assert.equal(firstConfidence, secondConfidence);
  const firstInsights = deriveExperimentInsights(sample, first);
  const secondInsights = deriveExperimentInsights([...sample].reverse(), second);
  assert.deepEqual(firstInsights, secondInsights);

  const firstMarkdown = buildExperimentMarkdown({
    familyKey: "family-test",
    category: "general",
    subcategory: null,
    metrics: first,
    insights: firstInsights
  });
  const secondMarkdown = buildExperimentMarkdown({
    familyKey: "family-test",
    category: "general",
    subcategory: null,
    metrics: second,
    insights: secondInsights
  });
  assert.equal(firstMarkdown, secondMarkdown);
});

test("insights highlight extremes and policy denials", () => {
  const metrics = deriveExperimentMetrics(sample);
  const insights = deriveExperimentInsights(sample, metrics);
  assert.equal(insights.bestScoreRun, "run-a");
  assert.equal(insights.worstScoreRun, "run-b");
  assert.equal(insights.mostEventfulRun, "run-b");
  assert.deepEqual(insights.notablePolicyDenials, ["run-b"]);
  assert.equal(
    insights.recommendedAction,
    "High policy denial rate; review denied runs for policy gaps."
  );
});

test("markdown includes research insights section", () => {
  const metrics = deriveExperimentMetrics(sample);
  const insights = deriveExperimentInsights(sample, metrics);
  const markdown = buildExperimentMarkdown({
    familyKey: "family-test",
    category: "general",
    subcategory: null,
    metrics,
    insights
  });
  assert.ok(markdown.includes("## Research Insights"));
  assert.ok(markdown.includes("Highest scoring run: run-a"));
  assert.ok(markdown.includes("Policy denials observed: 1"));
});
