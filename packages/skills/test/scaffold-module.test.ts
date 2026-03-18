import assert from "node:assert/strict";
import test from "node:test";
import type { SkillExecutionContext } from "../src/types";
import { scaffoldModuleSkill } from "../src/builtin/scaffold-module";

type MemoryFilesystemAdapter = {
  ensureDir(directoryPath: string): Promise<void>;
  writeFile(filePath: string, content: string): Promise<void>;
  directories: Set<string>;
  files: Map<string, string>;
};

function createMemoryFilesystemAdapter(): MemoryFilesystemAdapter {
  const directories = new Set<string>();
  const files = new Map<string, string>();

  return {
    directories,
    files,
    async ensureDir(directoryPath: string): Promise<void> {
      directories.add(directoryPath);
    },
    async writeFile(filePath: string, content: string): Promise<void> {
      files.set(filePath, content);
    }
  };
}

function createContext(filesystem: unknown): SkillExecutionContext {
  return {
    workspacePath: "/tmp/workspace",
    runId: "run-scaffold-1",
    adapters: {
      filesystem
    },
    repo: {}
  };
}

test("scaffold_module creates a library module and records artifacts", async () => {
  const filesystem = createMemoryFilesystemAdapter();
  const result = await scaffoldModuleSkill.execute(
    {
      moduleName: "billing_client",
      moduleType: "library",
      targetDirectory: "packages"
    },
    createContext(filesystem)
  );

  assert.equal(result.ok, true);
  assert.equal(result.output.moduleDirectory, "packages/billing_client");
  assert.equal(result.output.createdFiles.length, 3);
  assert.equal(filesystem.directories.has("packages/billing_client"), true);
  assert.equal(filesystem.directories.has("packages/billing_client/src"), true);
  assert.equal(
    filesystem.files.has("packages/billing_client/src/index.ts"),
    true
  );
  assert.equal(
    filesystem.files.has("packages/billing_client/package.json"),
    true
  );
  assert.equal(result.artifacts.length, result.output.createdFiles.length);
  assert.equal(
    result.artifacts.every((artifact) => artifact.path.startsWith("packages/billing_client/")),
    true
  );
});

test("scaffold_module rejects invalid module name edge case", async () => {
  const filesystem = createMemoryFilesystemAdapter();
  await assert.rejects(
    async () =>
      scaffoldModuleSkill.execute(
        {
          moduleName: "../bad",
          moduleType: "library",
          targetDirectory: "packages"
        },
        createContext(filesystem)
      ),
    /moduleName must start with a letter/
  );

  assert.equal(filesystem.files.size, 0);
  assert.equal(filesystem.directories.size, 0);
});
