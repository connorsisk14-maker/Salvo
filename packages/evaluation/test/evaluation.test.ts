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

test("required test command must be executed and pass", () => {
  const missing = evaluateRun({
    contractCompliance: 100,
    requiredTestCommands: ["echo salvo-test"],
    testsRun: [],
    requiredDeliverables: ["run-summary.md"],
    producedDeliverables: ["run-summary.md"],
    evidencePresent: true,
    learningsCount: 1,
    policyDeniedCount: 0
  });

  assert.equal(missing.outcome, "hard_failed");

  const failed = evaluateRun({
    contractCompliance: 100,
    requiredTestCommands: ["echo salvo-test"],
    testsRun: [{ command: "echo salvo-test", exit_code: 1 }],
    requiredDeliverables: ["run-summary.md"],
    producedDeliverables: ["run-summary.md"],
    evidencePresent: true,
    learningsCount: 1,
    policyDeniedCount: 0
  });

  assert.equal(failed.outcome, "hard_failed");
});

test("failed assertion lowers compliance and can fail score", () => {
  const result = evaluateRun({
    contractCompliance: 100,
    requiredAssertions: ["At least one deliverable produced."],
    finalPayloadPresent: true,
    requiredDeliverables: [],
    producedDeliverables: [],
    evidencePresent: true,
    learningsCount: 1,
    policyDeniedCount: 0
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.passed, false);
  assert.equal(result.score, 65);
  assert.ok(
    result.findings.includes("Assertion failed: At least one deliverable produced.")
  );
});

test("unrecognized assertion is reported but skipped for compliance", () => {
  const result = evaluateRun({
    contractCompliance: 100,
    requiredAssertions: ["Some custom condition."],
    finalPayloadPresent: true,
    requiredDeliverables: ["run-summary.md"],
    producedDeliverables: ["run-summary.md"],
    evidencePresent: true,
    learningsCount: 1,
    policyDeniedCount: 0
  });

  assert.equal(result.score, 100);
  assert.ok(
    result.findings.includes("Assertion not recognized and skipped: Some custom condition.")
  );
});

test("partial assertion success still yields partial compliance", () => {
  const result = evaluateRun({
    contractCompliance: 100,
    requiredAssertions: [
      "Runner emits a final payload event.",
      "At least one deliverable produced."
    ],
    finalPayloadPresent: false,
    requiredDeliverables: ["run-summary.md"],
    producedDeliverables: ["run-summary.md"],
    evidencePresent: true,
    learningsCount: 1,
    policyDeniedCount: 0
  });

  assert.equal(result.outcome, "passed");
  assert.equal(result.passed, true);
  assert.equal(result.score, 83);
  assert.ok(
    result.findings.includes("Assertion failed: Runner emits a final payload event.")
  );
});
