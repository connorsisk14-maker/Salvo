import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const sourcePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/index.ts"
);

test("research daemon does not import child_process or adapters", async () => {
  const source = await readFile(sourcePath, "utf8");
  assert.equal(source.includes("node:child_process"), false);
  assert.equal(source.includes("@salvo/adapters"), false);
  assert.equal(source.includes("spawn("), false);
});

test("research daemon uses restricted research repository", async () => {
  const source = await readFile(sourcePath, "utf8");
  assert.equal(source.includes("ResearchRepository"), true);
  assert.equal(source.includes("SalvoRepository"), false);
});
