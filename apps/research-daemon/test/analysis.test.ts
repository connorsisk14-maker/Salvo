import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildExperimentMarkdown,
  deriveExperimentConfidence,
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

  const firstMarkdown = buildExperimentMarkdown({
    familyKey: "family-test",
    category: "general",
    subcategory: null,
    metrics: first
  });
  const secondMarkdown = buildExperimentMarkdown({
    familyKey: "family-test",
    category: "general",
    subcategory: null,
    metrics: second
  });
  assert.equal(firstMarkdown, secondMarkdown);
});
