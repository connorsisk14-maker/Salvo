import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { buildToolPolicy, mergeToolPolicies, FilesystemAdapter, CommandAdapter } from "../src/index";

test("filesystem adapter blocks forbidden path writes", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "salvo-tools-"));
  const policy = buildToolPolicy(rootDir, {
    forbiddenPaths: [".git"],
    allowedWritePaths: ["."]
  });
  const adapter = new FilesystemAdapter(rootDir, policy);

  const result = await adapter.writeFile(".git/config", "nope");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.decision.reason, "forbidden_path");
  }
});

test("command adapter blocks non-allowlisted commands", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "salvo-tools-"));
  const policy = buildToolPolicy(rootDir, {
    allowedCommands: ["echo"]
  });
  const adapter = new CommandAdapter(policy);

  const result = await adapter.run("rm", ["-rf", "tmp"], rootDir);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.decision.reason, "command_not_allowlisted");
  }
});

test("merged tool policies narrow allowlists and timeout", () => {
  const rootDir = "/tmp/salvo-tools";
  const base = buildToolPolicy(rootDir, {
    allowedReadPaths: [".", "packages"],
    allowedWritePaths: [".", "packages"],
    allowedCommands: ["echo", "pnpm", "node"],
    allowedCommandCwds: ["."],
    commandTimeoutMs: 20_000
  });
  const merged = mergeToolPolicies(base, {
    allowedReadPaths: ["packages/shared"],
    allowedWritePaths: ["packages/shared"],
    allowedCommands: ["pnpm", "node"],
    allowedCommandCwds: ["packages/shared"],
    commandTimeoutMs: 10_000,
    forbiddenPaths: [".env"]
  }, rootDir);

  assert.deepEqual(merged.allowedReadPaths, [path.resolve(rootDir, "packages/shared")]);
  assert.deepEqual(merged.allowedWritePaths, [path.resolve(rootDir, "packages/shared")]);
  assert.deepEqual(merged.allowedCommands, ["node", "pnpm"]);
  assert.deepEqual(merged.allowedCommandCwds, [path.resolve(rootDir, "packages/shared")]);
  assert.equal(merged.commandTimeoutMs, 10_000);
  assert.ok(merged.forbiddenPaths.includes(path.resolve(rootDir, ".env")));
});
