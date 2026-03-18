import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  executeToolUse,
  type ExecuteToolUseInput,
  type ToolExecutorDeps,
  type ToolExecutorPersistence
} from "../src/index";
import type { EmailAdapter } from "@salvo/adapters";

function createHarness(
  overrides: Partial<ToolExecutorDeps> = {}
): {
  deps: ToolExecutorDeps;
  persistence: ToolExecutorPersistence;
  events: Array<{ eventType: string; level: string; payload: Record<string, unknown> }>;
  artifacts: Array<{ artifactType: string; path: string; metadataJson?: Record<string, unknown> }>;
} {
  const events: Array<{ eventType: string; level: string; payload: Record<string, unknown> }> = [];
  const artifacts: Array<{ artifactType: string; path: string; metadataJson?: Record<string, unknown> }> = [];

  const deps: ToolExecutorDeps = {
    async readFile(targetPath) {
      return {
        ok: true,
        content: `content:${targetPath}`,
        absolutePath: path.resolve("/tmp/salvo", targetPath)
      };
    },
    async writeFile(targetPath) {
      return {
        ok: true,
        absolutePath: path.resolve("/tmp/salvo", targetPath)
      };
    },
    async listDirectory(targetPath = ".") {
      return {
        ok: true,
        content: `dir:${targetPath}`,
        absolutePath: path.resolve("/tmp/salvo", targetPath)
      };
    },
    async runCommand(command, args, cwd) {
      return {
        ok: true,
        exitCode: 0,
        stdout: `${command} ${args.join(" ")}`.trim(),
        stderr: "",
        durationMs: 12,
        cwd
      } as unknown as Awaited<ReturnType<ToolExecutorDeps["runCommand"]>>;
    },
    ...overrides
  };

  const persistence: ToolExecutorPersistence = {
    async appendRunEvent(eventType, level, payload) {
      events.push({ eventType, level, payload });
    },
    async createArtifact(params) {
      artifacts.push(params);
    }
  };

  return { deps, persistence, events, artifacts };
}

function buildInput(
  name: string,
  toolInput: Record<string, unknown>,
  overrides: Partial<ExecuteToolUseInput> = {}
): ExecuteToolUseInput {
  const harness = createHarness();

  return {
    block: {
      type: "tool_use",
      id: "tool-1",
      name,
      input: toolInput
    },
    workspaceRoot: "/tmp/salvo",
    deps: harness.deps,
    persistence: harness.persistence,
    ...overrides
  };
}

test("executeToolUse dispatches read_file and returns file content", async () => {
  const harness = createHarness();
  const outcome = await executeToolUse({
    block: {
      type: "tool_use",
      id: "read-1",
      name: "read_file",
      input: { path: "README.md" }
    },
    workspaceRoot: "/tmp/salvo",
    deps: harness.deps,
    persistence: harness.persistence
  });

  assert.equal(outcome.policyDenied, false);
  assert.equal(outcome.toolResult.isError, undefined);
  assert.deepEqual(JSON.parse(outcome.toolResult.content), {
    ok: true,
    path: "README.md",
    absolute_path: "/tmp/salvo/README.md",
    content: "content:README.md"
  });
  assert.deepEqual(
    harness.events.map((event) => event.eventType),
    ["tool.called", "tool.result"]
  );
});

test("executeToolUse returns a deny error when read_file is blocked", async () => {
  const harness = createHarness({
    async readFile() {
      return {
        ok: false,
        decision: {
          reason: "path_forbidden",
          message: "blocked"
        }
      };
    }
  });

  const outcome = await executeToolUse({
    block: {
      type: "tool_use",
      id: "read-2",
      name: "read_file",
      input: { path: ".env" }
    },
    workspaceRoot: "/tmp/salvo",
    deps: harness.deps,
    persistence: harness.persistence
  });

  assert.equal(outcome.policyDenied, true);
  assert.equal(outcome.toolResult.isError, true);
  assert.equal(harness.events[1]?.eventType, "policy.denied");
});

test("executeToolUse defaults list_directory to the workspace root", async () => {
  const harness = createHarness();
  const outcome = await executeToolUse({
    block: {
      type: "tool_use",
      id: "list-1",
      name: "list_directory",
      input: {}
    },
    workspaceRoot: "/tmp/salvo",
    deps: harness.deps,
    persistence: harness.persistence
  });

  assert.deepEqual(JSON.parse(outcome.toolResult.content), {
    ok: true,
    path: ".",
    absolute_path: "/tmp/salvo",
    content: "dir:."
  });
});

test("executeToolUse persists artifacts for successful write_file", async () => {
  const harness = createHarness();
  const outcome = await executeToolUse({
    block: {
      type: "tool_use",
      id: "write-1",
      name: "write_file",
      input: { path: "notes.md", content: "# hi" }
    },
    workspaceRoot: "/tmp/salvo",
    deps: harness.deps,
    persistence: harness.persistence
  });

  assert.equal(outcome.policyDenied, false);
  assert.equal(outcome.artifactPath, "/tmp/salvo/notes.md");
  assert.deepEqual(harness.artifacts, [
    {
      artifactType: "markdown",
      path: "/tmp/salvo/notes.md",
      metadataJson: {
        label: "notes.md"
      }
    }
  ]);
  assert.equal(harness.events.some((event) => event.eventType === "artifact.created"), true);
});

test("executeToolUse does not create artifacts when write_file is denied", async () => {
  const harness = createHarness({
    async writeFile() {
      return {
        ok: false,
        decision: {
          reason: "path_forbidden",
          message: "blocked"
        }
      };
    }
  });

  const outcome = await executeToolUse({
    block: {
      type: "tool_use",
      id: "write-2",
      name: "write_file",
      input: { path: ".env", content: "SECRET=1" }
    },
    workspaceRoot: "/tmp/salvo",
    deps: harness.deps,
    persistence: harness.persistence
  });

  assert.equal(outcome.policyDenied, true);
  assert.equal(harness.artifacts.length, 0);
  assert.equal(harness.events.some((event) => event.eventType === "policy.denied"), true);
});

test("executeToolUse records required test command evidence for run_command", async () => {
  const harness = createHarness();
  const outcome = await executeToolUse({
    block: {
      type: "tool_use",
      id: "cmd-1",
      name: "run_command",
      input: {
        command: "pnpm",
        args: ["test"],
        cwd: "."
      }
    },
    workspaceRoot: "/tmp/salvo",
    requiredTestCommands: new Set(["pnpm test"]),
    deps: harness.deps,
    persistence: harness.persistence
  });

  assert.equal(outcome.policyDenied, false);
  assert.deepEqual(outcome.requiredTestCommandResult, {
    command: "pnpm test",
    evidence: {
      command: "pnpm test",
      exit_code: 0,
      stdout: "pnpm test",
      stderr: "",
      duration_ms: 12
    }
  });
});

test("executeToolUse returns an error result for denied run_command", async () => {
  const harness = createHarness({
    async runCommand() {
      return {
        ok: false,
        decision: {
          reason: "command_not_allowlisted",
          message: "blocked"
        },
        durationMs: 5
      };
    }
  });

  const outcome = await executeToolUse({
    block: {
      type: "tool_use",
      id: "cmd-2",
      name: "run_command",
      input: {
        command: "rm",
        args: ["-rf", "."]
      }
    },
    workspaceRoot: "/tmp/salvo",
    requiredTestCommands: new Set(["rm -rf ."]),
    deps: harness.deps,
    persistence: harness.persistence
  });

  assert.equal(outcome.policyDenied, true);
  assert.equal(outcome.toolResult.isError, true);
  assert.deepEqual(outcome.requiredTestCommandResult, {
    command: "rm -rf .",
    evidence: {
      command: "rm -rf .",
      denied: true,
      reason: "command_not_allowlisted",
      message: "blocked",
      duration_ms: 5
    }
  });
});

test("executeToolUse returns the completion payload without side effects", async () => {
  const harness = createHarness();
  const completionPayload = {
    status: "completed" as const,
    summary: "done",
    deliverables: ["run-summary.md"],
    evidence: {
      tests_run: [],
      command_results: [],
      files_changed: 1
    },
    roadblocks: [],
    learnings: []
  };

  const outcome = await executeToolUse({
    block: {
      type: "tool_use",
      id: "complete-1",
      name: "salvo_complete",
      input: completionPayload
    },
    workspaceRoot: "/tmp/salvo",
    deps: harness.deps,
    persistence: harness.persistence
  });

  assert.deepEqual(outcome.completionPayload, completionPayload);
  assert.equal(harness.artifacts.length, 0);
  assert.deepEqual(
    harness.events.map((event) => event.eventType),
    ["tool.called", "tool.result"]
  );
});

test("executeToolUse dispatches registered skill tools and persists skill artifacts/events", async () => {
  const harness = createHarness();
  const context = {
    workspacePath: "/tmp/salvo",
    runId: "run-42",
    adapters: {
      queue: true
    },
    repo: {
      persistence: true
    }
  };
  let capturedContext: Record<string, unknown> | undefined;
  let capturedInput: Record<string, unknown> | undefined;

  const outcome = await executeToolUse({
    block: {
      type: "tool_use",
      id: "skill-1",
      name: "generate_summary",
      input: {
        prompt: "Summarize the run."
      }
    },
    workspaceRoot: "/tmp/salvo",
    skillRegistry: {
      get(name) {
        if (name !== "generate_summary") {
          return undefined;
        }

        return {
          name,
          async execute(input, skillContext) {
            capturedInput = input;
            capturedContext = skillContext;

            return {
              ok: true,
              output: {
                summary: "done"
              },
              artifacts: [
                {
                  path: "artifacts/summary.md",
                  artifactType: "markdown",
                  metadata: {
                    label: "summary"
                  }
                }
              ],
              events: [
                {
                  type: "summary.started",
                  level: "info",
                  payload: {
                    phase: "start"
                  }
                },
                {
                  type: "summary.completed",
                  level: "error",
                  payload: {
                    phase: "end"
                  }
                }
              ]
            };
          }
        };
      }
    },
    skillExecutionContext: context,
    deps: harness.deps,
    persistence: harness.persistence
  });

  assert.equal(outcome.policyDenied, false);
  assert.equal(outcome.toolResult.isError, undefined);
  assert.equal(outcome.artifactPath, "/tmp/salvo/artifacts/summary.md");
  assert.deepEqual(capturedInput, { prompt: "Summarize the run." });
  assert.deepEqual(capturedContext, context);
  assert.deepEqual(harness.artifacts, [
    {
      artifactType: "markdown",
      path: "/tmp/salvo/artifacts/summary.md",
      metadataJson: {
        label: "summary"
      }
    }
  ]);
  assert.equal(
    harness.events.some(
      (event) => event.eventType === "tool.result" && event.payload.skill_event_type === "summary.started"
    ),
    true
  );
  assert.equal(
    harness.events.some(
      (event) =>
        event.eventType === "tool.result" &&
        event.payload.skill_event_type === "summary.completed" &&
        event.level === "warn"
    ),
    true
  );
  assert.equal(harness.events.some((event) => event.eventType === "artifact.created"), true);
  assert.deepEqual(JSON.parse(outcome.toolResult.content), {
    ok: true,
    tool: "generate_summary",
    output: {
      summary: "done"
    },
    artifacts: [
      {
        path: "/tmp/salvo/artifacts/summary.md",
        artifact_type: "markdown",
        metadata: {
          label: "summary"
        }
      }
    ],
    events: [
      {
        type: "summary.started",
        level: "info",
        payload: {
          phase: "start"
        }
      },
      {
        type: "summary.completed",
        level: "error",
        payload: {
          phase: "end"
        }
      }
    ]
  });
});

test("executeToolUse returns an error when a registered skill throws", async () => {
  const harness = createHarness();

  const outcome = await executeToolUse({
    block: {
      type: "tool_use",
      id: "skill-2",
      name: "explode",
      input: {}
    },
    workspaceRoot: "/tmp/salvo",
    skillRegistry: {
      get(name) {
        if (name !== "explode") {
          return undefined;
        }

        return {
          name,
          async execute() {
            throw new Error("boom");
          }
        };
      }
    },
    deps: harness.deps,
    persistence: harness.persistence
  });

  assert.equal(outcome.policyDenied, false);
  assert.equal(outcome.toolResult.isError, true);
  assert.deepEqual(JSON.parse(outcome.toolResult.content), {
    ok: false,
    error: "skill_execution_failed",
    tool: "explode",
    message: "boom"
  });
  assert.equal(harness.artifacts.length, 0);
  assert.deepEqual(
    harness.events.map((event) => event.eventType),
    ["tool.called", "tool.result"]
  );
});

test("executeToolUse returns an error for unsupported tools", async () => {
  const harness = createHarness();
  const outcome = await executeToolUse({
    block: {
      type: "tool_use",
      id: "unknown-1",
      name: "explode_world",
      input: {}
    },
    workspaceRoot: "/tmp/salvo",
    deps: harness.deps,
    persistence: harness.persistence
  });

  assert.equal(outcome.policyDenied, false);
  assert.equal(outcome.toolResult.isError, true);
  assert.deepEqual(JSON.parse(outcome.toolResult.content), {
    ok: false,
    error: "unsupported_tool",
    tool: "explode_world"
  });
});

test("executeToolUse returns an error for invalid tool input", async () => {
  const harness = createHarness();
  const outcome = await executeToolUse({
    block: {
      type: "tool_use",
      id: "invalid-1",
      name: "write_file",
      input: { path: "notes.md", content: 123 }
    },
    workspaceRoot: "/tmp/salvo",
    deps: harness.deps,
    persistence: harness.persistence
  });

  assert.equal(outcome.policyDenied, false);
  assert.equal(outcome.toolResult.isError, true);
  assert.deepEqual(JSON.parse(outcome.toolResult.content), {
    ok: false,
    error: "invalid_input",
    message: "write_file requires a non-empty string path and string content."
  });
});

test("executeToolUse enforces the per-run email send limit", async () => {
  const harness = createHarness();
  const emailAdapter = {
    key: "email",
    async health() {
      return {
        status: "ready",
        detail: "ok"
      };
    },
    async run() {
      return {
        ok: true,
        detail: "sent",
        output: {
          messageId: "msg-1",
          accepted: ["ops@example.com"],
          rejected: []
        }
      };
    }
  } as unknown as EmailAdapter;

  const outcome = await executeToolUse({
    block: {
      type: "tool_use",
      id: "email-1",
      name: "send_email",
      input: {
        subject: "Status",
        text: "Hello"
      }
    },
    workspaceRoot: "/tmp/salvo",
    runId: "run-email",
    deps: harness.deps,
    persistence: harness.persistence,
    emailAdapter,
    emailSendPolicy: {
      maxSends: 1,
      sendsUsed: 1
    }
  });

  assert.equal(outcome.policyDenied, true);
  assert.equal(outcome.toolResult.isError, true);
  assert.equal(
    harness.events.some(
      (event) =>
        event.eventType === "policy.denied" && event.payload.reason === "email_send_limit"
    ),
    true
  );
});
