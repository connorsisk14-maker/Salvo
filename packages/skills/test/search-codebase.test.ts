import assert from "node:assert/strict";
import test from "node:test";
import type { SkillExecutionContext } from "../src/types";
import { searchCodebaseSkill } from "../src/builtin/search-codebase";

type CommandExecutionResult =
  | {
      ok: true;
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
    }
  | {
      ok: false;
      decision: {
        reason: string;
        message: string;
      };
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      durationMs?: number;
    };

type AdapterCall = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
};

class FakeCommandAdapter {
  readonly calls: AdapterCall[] = [];

  constructor(private readonly results: CommandExecutionResult[]) {}

  async run(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs?: number
  ): Promise<CommandExecutionResult> {
    this.calls.push({
      command,
      args,
      cwd,
      timeoutMs
    });
    return this.results.shift() ?? {
      ok: true,
      exitCode: 1,
      stdout: "",
      stderr: "",
      durationMs: 1
    };
  }
}

function createContext(adapter: FakeCommandAdapter): SkillExecutionContext {
  return {
    workspacePath: "/workspace",
    runId: "run-search-codebase-test",
    adapters: {
      command: adapter
    },
    repo: {}
  };
}

function rgMatchLine(file: string, line: number, content: string): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: {
        text: file
      },
      lines: {
        text: `${content}\n`
      },
      line_number: line
    }
  });
}

test("search_codebase filters results by extension", async () => {
  const adapter = new FakeCommandAdapter([
    {
      ok: true,
      exitCode: 0,
      stdout: [rgMatchLine("src/keep.ts", 3, "const keep = true;"), rgMatchLine("src/skip.js", 6, "const skip = true;")].join(
        "\n"
      ),
      stderr: "",
      durationMs: 4
    }
  ]);

  const result = await searchCodebaseSkill.execute(
    {
      pattern: "const",
      path: "src",
      extensions: ["ts"]
    },
    createContext(adapter)
  );

  assert.equal(result.ok, true);
  assert.equal(result.output.matches.length, 1);
  assert.deepEqual(result.output.matches[0], {
    file: "src/keep.ts",
    line: 3,
    content: "const keep = true;"
  });

  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].command, "rg");
  assert.equal(adapter.calls[0].cwd, "/workspace");
  assert.equal(adapter.calls[0].args.includes("**/*.ts"), true);
});

test("search_codebase caps oversized result sets", async () => {
  const adapter = new FakeCommandAdapter([
    {
      ok: true,
      exitCode: 0,
      stdout: [
        rgMatchLine("src/one.ts", 1, "match one"),
        rgMatchLine("src/two.ts", 2, "match two"),
        rgMatchLine("src/three.ts", 3, "match three")
      ].join("\n"),
      stderr: "",
      durationMs: 6
    }
  ]);

  const result = await searchCodebaseSkill.execute(
    {
      pattern: "match",
      path: "src",
      maxResults: 2
    },
    createContext(adapter)
  );

  assert.equal(result.ok, true);
  assert.equal(result.output.totalMatches, 3);
  assert.equal(result.output.matches.length, 2);
  assert.equal(result.output.capped, true);
});

test("search_codebase blocks forbidden paths before command execution", async () => {
  const adapter = new FakeCommandAdapter([]);
  const result = await searchCodebaseSkill.execute(
    {
      pattern: "token",
      path: ".git"
    },
    createContext(adapter)
  );

  assert.equal(result.ok, false);
  assert.equal(result.output.errorCode, "forbidden_path");
  assert.equal(adapter.calls.length, 0);
});

test("search_codebase surfaces command denied behavior", async () => {
  const adapter = new FakeCommandAdapter([
    {
      ok: false,
      decision: {
        reason: "command_not_allowlisted",
        message: "Command rg is not allowlisted."
      }
    }
  ]);

  const result = await searchCodebaseSkill.execute(
    {
      pattern: "hello",
      path: "."
    },
    createContext(adapter)
  );

  assert.equal(result.ok, false);
  assert.equal(result.output.errorCode, "command_not_allowlisted");
  assert.equal(result.output.error, "Command rg is not allowlisted.");
});
