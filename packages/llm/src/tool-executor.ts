import path from "node:path";
import type { LlmContentBlock } from "./types";

export type ToolUseBlock = Extract<LlmContentBlock, { type: "tool_use" }>;
export type ToolResultBlock = Extract<LlmContentBlock, { type: "tool_result" }>;

type ToolDecision = {
  reason: string;
  message: string;
};

type FileReadSuccess = {
  ok: true;
  content: string;
  absolutePath: string;
};

type FileReadFailure = {
  ok: false;
  decision: ToolDecision;
};

type FileWriteSuccess = {
  ok: true;
  absolutePath: string;
};

type FileWriteFailure = {
  ok: false;
  decision: ToolDecision;
};

type CommandSuccess = {
  ok: true;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

type CommandFailure = {
  ok: false;
  decision: ToolDecision;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
};

export type SalvoCompletionPayload = {
  status: "completed" | "blocked" | "failed";
  summary: string;
  deliverables: string[];
  evidence: {
    tests_run: Array<{ command: string; exit_code?: number; denied?: boolean }>;
    command_results: Record<string, unknown>[];
    files_changed: number;
  };
  roadblocks: Array<{ type: string; description: string }>;
  learnings: Array<{ type: string; title: string; body: string }>;
};

export type ToolExecutorDeps = {
  readFile(path: string): Promise<FileReadSuccess | FileReadFailure>;
  writeFile(path: string, content: string): Promise<FileWriteSuccess | FileWriteFailure>;
  listDirectory(path?: string): Promise<FileReadSuccess | FileReadFailure>;
  runCommand(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs?: number
  ): Promise<CommandSuccess | CommandFailure>;
};

export type ToolExecutorPersistence = {
  appendRunEvent(
    eventType: "tool.called" | "tool.result" | "policy.denied" | "artifact.created",
    level: "info" | "warn",
    payload: Record<string, unknown>
  ): Promise<void>;
  createArtifact(params: {
    artifactType: string;
    path: string;
    metadataJson?: Record<string, unknown>;
  }): Promise<void>;
};

export type ExecuteToolUseInput = {
  block: ToolUseBlock;
  workspaceRoot: string;
  requiredTestCommands?: Set<string>;
  completionToolName?: string;
  deps: ToolExecutorDeps;
  persistence: ToolExecutorPersistence;
};

export type ToolExecutionOutcome = {
  toolResult: ToolResultBlock;
  completionPayload?: SalvoCompletionPayload;
  requiredTestCommandResult?: {
    command: string;
    evidence: Record<string, unknown>;
  };
  artifactPath?: string;
  policyDenied: boolean;
};

function buildToolResult(toolUseId: string, content: Record<string, unknown>, isError = false): ToolResultBlock {
  return {
    type: "tool_result",
    toolUseId,
    content: JSON.stringify(content),
    isError: isError || undefined
  };
}

function inferArtifactType(targetPath: string): string {
  return targetPath.endsWith(".json") ? "json" : "markdown";
}

function canonicalizeCommand(command: string, args: string[]): string {
  return [command.trim(), ...args.map((arg) => arg.trim())].filter(Boolean).join(" ");
}

function commandEvidence(command: string, result: CommandSuccess | CommandFailure): Record<string, unknown> {
  if (!result.ok) {
    return {
      command,
      denied: true,
      reason: result.decision.reason,
      message: result.decision.message,
      ...(typeof result.durationMs === "number" ? { duration_ms: result.durationMs } : {})
    };
  }

  return {
    command,
    exit_code: result.exitCode,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    duration_ms: result.durationMs
  };
}

function readString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readStringArray(input: Record<string, unknown>, key: string): string[] | null {
  const value = input[key];
  if (!Array.isArray(value)) {
    return null;
  }

  const items = value.filter((entry): entry is string => typeof entry === "string");
  return items.length === value.length ? items : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompletionPayload(value: Record<string, unknown>): value is SalvoCompletionPayload {
  if (!["completed", "blocked", "failed"].includes(String(value.status))) {
    return false;
  }

  if (typeof value.summary !== "string" || value.summary.trim().length === 0) {
    return false;
  }

  if (
    !Array.isArray(value.deliverables) ||
    value.deliverables.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    return false;
  }

  if (!isRecord(value.evidence)) {
    return false;
  }

  const testsRun = value.evidence.tests_run;
  const commandResults = value.evidence.command_results;
  const filesChanged = value.evidence.files_changed;
  if (!Array.isArray(testsRun) || !Array.isArray(commandResults) || typeof filesChanged !== "number" || filesChanged < 0) {
    return false;
  }

  if (
    testsRun.some(
      (entry) =>
        !isRecord(entry) ||
        typeof entry.command !== "string" ||
        ("exit_code" in entry && typeof entry.exit_code !== "number") ||
        ("denied" in entry && typeof entry.denied !== "boolean")
    )
  ) {
    return false;
  }

  if (commandResults.some((entry) => !isRecord(entry))) {
    return false;
  }

  if (
    !Array.isArray(value.roadblocks) ||
    value.roadblocks.some(
      (entry) =>
        !isRecord(entry) ||
        typeof entry.type !== "string" ||
        typeof entry.description !== "string"
    )
  ) {
    return false;
  }

  if (
    !Array.isArray(value.learnings) ||
    value.learnings.some(
      (entry) =>
        !isRecord(entry) ||
        typeof entry.type !== "string" ||
        typeof entry.title !== "string" ||
        typeof entry.body !== "string"
    )
  ) {
    return false;
  }

  return true;
}

async function emitToolResult(
  persistence: ToolExecutorPersistence,
  payload: Record<string, unknown>
): Promise<void> {
  await persistence.appendRunEvent("tool.result", "info", payload);
}

async function emitPolicyDenied(
  persistence: ToolExecutorPersistence,
  payload: Record<string, unknown>
): Promise<void> {
  await persistence.appendRunEvent("policy.denied", "warn", payload);
}

function invalidInputOutcome(block: ToolUseBlock, message: string): ToolExecutionOutcome {
  return {
    toolResult: buildToolResult(block.id, {
      ok: false,
      error: "invalid_input",
      message
    }, true),
    policyDenied: false
  };
}

export async function executeToolUse(input: ExecuteToolUseInput): Promise<ToolExecutionOutcome> {
  const completionToolName = input.completionToolName?.trim() || "salvo_complete";

  await input.persistence.appendRunEvent("tool.called", "info", {
    tool: input.block.name,
    tool_use_id: input.block.id,
    input: input.block.input
  });

  if (input.block.name === "read_file") {
    const targetPath = readString(input.block.input, "path");
    if (!targetPath) {
      return invalidInputOutcome(input.block, "read_file requires a non-empty string path.");
    }

    const result = await input.deps.readFile(targetPath);
    if (!result.ok) {
      await emitPolicyDenied(input.persistence, {
        tool: input.block.name,
        tool_use_id: input.block.id,
        path: targetPath,
        reason: result.decision.reason,
        message: result.decision.message
      });

      return {
        toolResult: buildToolResult(input.block.id, {
          ok: false,
          error: "policy_denied",
          path: targetPath,
          reason: result.decision.reason,
          message: result.decision.message
        }, true),
        policyDenied: true
      };
    }

    const payload = {
      tool: input.block.name,
      tool_use_id: input.block.id,
      path: targetPath,
      absolute_path: result.absolutePath
    };
    await emitToolResult(input.persistence, payload);

    return {
      toolResult: buildToolResult(input.block.id, {
        ok: true,
        path: targetPath,
        absolute_path: result.absolutePath,
        content: result.content
      }),
      policyDenied: false
    };
  }

  if (input.block.name === "list_directory") {
    const targetPath = readString(input.block.input, "path") ?? ".";
    const result = await input.deps.listDirectory(targetPath);
    if (!result.ok) {
      await emitPolicyDenied(input.persistence, {
        tool: input.block.name,
        tool_use_id: input.block.id,
        path: targetPath,
        reason: result.decision.reason,
        message: result.decision.message
      });

      return {
        toolResult: buildToolResult(input.block.id, {
          ok: false,
          error: "policy_denied",
          path: targetPath,
          reason: result.decision.reason,
          message: result.decision.message
        }, true),
        policyDenied: true
      };
    }

    await emitToolResult(input.persistence, {
      tool: input.block.name,
      tool_use_id: input.block.id,
      path: targetPath,
      absolute_path: result.absolutePath
    });

    return {
      toolResult: buildToolResult(input.block.id, {
        ok: true,
        path: targetPath,
        absolute_path: result.absolutePath,
        content: result.content
      }),
      policyDenied: false
    };
  }

  if (input.block.name === "write_file") {
    const targetPath = readString(input.block.input, "path");
    const content = input.block.input.content;
    if (!targetPath || typeof content !== "string") {
      return invalidInputOutcome(
        input.block,
        "write_file requires a non-empty string path and string content."
      );
    }

    const result = await input.deps.writeFile(targetPath, content);
    if (!result.ok) {
      await emitPolicyDenied(input.persistence, {
        tool: input.block.name,
        tool_use_id: input.block.id,
        path: targetPath,
        reason: result.decision.reason,
        message: result.decision.message
      });

      return {
        toolResult: buildToolResult(input.block.id, {
          ok: false,
          error: "policy_denied",
          path: targetPath,
          reason: result.decision.reason,
          message: result.decision.message
        }, true),
        policyDenied: true
      };
    }

    const artifactType = inferArtifactType(targetPath);
    await input.persistence.createArtifact({
      artifactType,
      path: result.absolutePath,
      metadataJson: {
        label: targetPath
      }
    });
    await input.persistence.appendRunEvent("artifact.created", "info", {
      path: result.absolutePath,
      artifact_type: artifactType
    });
    await emitToolResult(input.persistence, {
      tool: input.block.name,
      tool_use_id: input.block.id,
      path: targetPath,
      absolute_path: result.absolutePath
    });

    return {
      toolResult: buildToolResult(input.block.id, {
        ok: true,
        path: targetPath,
        absolute_path: result.absolutePath,
        artifact_type: artifactType
      }),
      artifactPath: result.absolutePath,
      policyDenied: false
    };
  }

  if (input.block.name === "run_command") {
    const command = readString(input.block.input, "command");
    const args = readStringArray(input.block.input, "args") ?? [];
    const cwdInput = readString(input.block.input, "cwd");

    if (!command) {
      return invalidInputOutcome(input.block, "run_command requires a non-empty string command.");
    }
    if (!Array.isArray(args)) {
      return invalidInputOutcome(input.block, "run_command args must be an array of strings.");
    }

    const cwd = cwdInput ? path.resolve(input.workspaceRoot, cwdInput) : input.workspaceRoot;
    const canonicalCommand = canonicalizeCommand(command, args);
    const result = await input.deps.runCommand(command, args, cwd);
    const evidence = commandEvidence(canonicalCommand, result);
    const requiredTestCommandResult = input.requiredTestCommands?.has(canonicalCommand)
      ? {
          command: canonicalCommand,
          evidence
        }
      : undefined;

    if (!result.ok) {
      await emitPolicyDenied(input.persistence, {
        tool: input.block.name,
        tool_use_id: input.block.id,
        command,
        args,
        cwd,
        reason: result.decision.reason,
        message: result.decision.message
      });

      return {
        toolResult: buildToolResult(input.block.id, {
          ok: false,
          error: "command_failed",
          command,
          args,
          cwd,
          ...evidence
        }, true),
        requiredTestCommandResult,
        policyDenied: true
      };
    }

    await emitToolResult(input.persistence, {
      tool: input.block.name,
      tool_use_id: input.block.id,
      command,
      args,
      cwd,
      exit_code: result.exitCode,
      duration_ms: result.durationMs
    });

    return {
      toolResult: buildToolResult(input.block.id, {
        ok: true,
        command,
        args,
        cwd,
        ...evidence
      }),
      requiredTestCommandResult,
      policyDenied: false
    };
  }

  if (input.block.name === completionToolName) {
    if (!isCompletionPayload(input.block.input)) {
      return invalidInputOutcome(
        input.block,
        `${completionToolName} requires a valid terminal completion payload.`
      );
    }

    await emitToolResult(input.persistence, {
      tool: input.block.name,
      tool_use_id: input.block.id,
      status: input.block.input.status,
      deliverable_count: input.block.input.deliverables.length
    });

    return {
      toolResult: buildToolResult(input.block.id, {
        ok: true,
        status: input.block.input.status
      }),
      completionPayload: input.block.input,
      policyDenied: false
    };
  }

  const unsupportedResult = buildToolResult(input.block.id, {
    ok: false,
    error: "unsupported_tool",
    tool: input.block.name
  }, true);
  await emitToolResult(input.persistence, {
    tool: input.block.name,
    tool_use_id: input.block.id,
    error: "unsupported_tool"
  });

  return {
    toolResult: unsupportedResult,
    policyDenied: false
  };
}
