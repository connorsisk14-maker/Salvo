import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRun } from "../src/index";

test("evaluation is deterministic with same input", () => {
  const input = {
    contractCompliance: 100,
    testsExitCode: 0,
    requiredDeliverables: ["run-summary.md"],
    producedDeliverables: ["run-summary.md"],
    evidencePresent: true,
    learningsCount: 1,
    policyDeniedCount: 0
  } as const;

  const first = evaluateRun(input);
  const second = evaluateRun(input);
  assert.deepEqual(first, second);
});

test("policy denial hard fails regardless of scoring", () => {
  const result = evaluateRun({
    contractCompliance: 100,
    testsExitCode: 0,
    requiredDeliverables: ["run-summary.md"],
    producedDeliverables: ["run-summary.md"],
    evidencePresent: true,
    learningsCount: 1,
    policyDeniedCount: 1
  });

  assert.equal(result.outcome, "hard_failed");
  assert.equal(result.passed, false);
  assert.equal(result.score, 0);
});
