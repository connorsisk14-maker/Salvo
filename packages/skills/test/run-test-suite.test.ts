import assert from "node:assert/strict";
import test from "node:test";
import type { SkillExecutionContext } from "../src/index";
import { parseTestSuiteCounts, runTestSuiteSkill } from "../src/builtin/run-test-suite";

function buildContextWithCommandAdapter(runCommand: (request: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}) => Promise<{
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  output?: string;
  timedOut?: boolean;
  timeout?: boolean;
  denied?: boolean;
}>): SkillExecutionContext {
  return {
    workspacePath: "/repo/salvo",
    runId: "run-123",
    adapters: {
      command: {
        runCommand
      }
    },
    repo: {}
  };
}

test("parseTestSuiteCounts handles vitest summary output", () => {
  const output = `
stdout | test/example.test.ts
 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  10:02:11
   Duration  312ms
  `;

  const counts = parseTestSuiteCounts(output);
  assert.deepEqual(counts, {
    passed: 3,
    failed: 0,
    skipped: 0,
    total: 3
  });
});

test("run_test_suite returns parsed totals for a failing jest run", async () => {
  let capturedRequest:
    | {
        command: string;
        args: string[];
        cwd: string;
        timeoutMs?: number;
      }
    | undefined;
  const context = buildContextWithCommandAdapter(async (request) => {
    capturedRequest = request;
    return {
      exitCode: 1,
      stdout: [
        "Test Suites: 1 failed, 1 total",
        "Tests:       1 failed, 2 passed, 3 total",
        "Time:        1.212 s"
      ].join("\n"),
      stderr: ""
    };
  });

  const result = await runTestSuiteSkill.execute(
    {
      command: "pnpm",
      args: ["test", "--", "--runInBand"],
      pattern: "planner",
      timeoutMs: 30_000
    },
    context
  );

  assert.deepEqual(capturedRequest, {
    command: "pnpm",
    args: ["test", "--", "--runInBand", "planner"],
    cwd: "/repo/salvo",
    timeoutMs: 30_000
  });
  assert.equal(result.ok, false);
  assert.equal(result.output.exitCode, 1);
  assert.deepEqual(result.output.counts, {
    passed: 2,
    failed: 1,
    skipped: 0,
    total: 3
  });
  assert.match(result.output.output, /1 failed, 2 passed, 3 total/);
  assert.equal(result.events[0]?.type, "test_suite.run_completed");
});

test("run_test_suite reports timeout behavior and keeps raw output", async () => {
  const context = buildContextWithCommandAdapter(async () => ({
    exitCode: null,
    output: [
      " RUN  v2.1.7 /repo/salvo",
      "Timed out waiting for tests to finish after 60000ms"
    ].join("\n"),
    timedOut: true
  }));

  const result = await runTestSuiteSkill.execute(
    {
      command: "pnpm",
      args: ["vitest", "run"],
      timeoutMs: 60_000
    },
    context
  );

  assert.equal(result.ok, false);
  assert.equal(result.output.timedOut, true);
  assert.equal(result.output.denied, false);
  assert.equal(result.output.exitCode, null);
  assert.equal(result.output.counts.total, 0);
  assert.match(result.output.output, /Timed out waiting for tests to finish/);
  assert.equal(result.events[0]?.type, "test_suite.run_completed");
  assert.equal(result.events[0]?.level, "warn");
});
