import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { buildToolPolicy, FilesystemAdapter, CommandAdapter } from "../src/index";

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
