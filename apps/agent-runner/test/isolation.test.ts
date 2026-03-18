import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runnerSourcePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/index.ts"
);
const source = readFileSync(runnerSourcePath, "utf8");

test("agent-runner does not import child_process directly", () => {
  assert.equal(source.includes("node:child_process"), false);
  assert.equal(source.includes("from \"child_process\""), false);
});

test("agent-runner uses policy-enforced adapters", () => {
  assert.equal(source.includes("CommandAdapter"), true);
  assert.equal(source.includes("FilesystemAdapter"), true);
});

test("agent-runner delegates iterative execution through agent-loop", () => {
  assert.equal(source.includes("runAgentLoop"), true);
});
