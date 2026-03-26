import path from "node:path";
import type { LlmContentBlock } from "./types";
import type { EmailAdapter, SlackAdapter } from "@salvo/adapters";

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

type SkillArtifactLike = {
  path: string;
  artifactType?: string;
  metadata?: Record<string, unknown>;
};

type SkillEventLike = {
  type: string;
  level?: "debug" | "info" | "warn" | "error";
  payload?: Record<string, unknown>;
};

type SkillResultLike = {
  ok: boolean;
  output: Record<string, unknown>;
  artifacts: SkillArtifactLike[];
  events: SkillEventLike[];
};

type SkillExecutionContextLike = {
  workspacePath: string;
  runId: string;
  adapters: Record<string, unknown>;
  repo: Record<string, unknown>;
};

type SkillLike = {
  name: string;
  execute(
    input: Record<string, unknown>,
    context: SkillExecutionContextLike
  ): Promise<SkillResultLike> | SkillResultLike;
};

type SkillRegistryLike = {
  get(name: string): SkillLike | undefined;
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
  runId?: string;
  requiredTestCommands?: Set<string>;
  completionToolName?: string;
  skillRegistry?: SkillRegistryLike;
  skillExecutionContext?: SkillExecutionContextLike;
  deps: ToolExecutorDeps;
  persistence: ToolExecutorPersistence;
  emailAdapter?: EmailAdapter;
  emailSendPolicy?: {
    maxSends: number;
    sendsUsed: number;
  };
  slackAdapter?: SlackAdapter;
  slackSendPolicy?: {
    maxSends: number;
    sendsUsed: number;
  };
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

function resolveArtifactPath(workspaceRoot: string, artifactPath: string): string {
  return path.isAbsolute(artifactPath) ? artifactPath : path.resolve(workspaceRoot, artifactPath);
}

function mapSkillEventLevel(level?: SkillEventLike["level"]): "info" | "warn" {
  return level === "warn" || level === "error" ? "warn" : "info";
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

function normalizeSkillResult(result: SkillResultLike): SkillResultLike {
  return {
    ok: result.ok,
    output: isRecord(result.output) ? result.output : {},
    artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
    events: Array.isArray(result.events) ? result.events : []
  };
}

async function persistSkillArtifacts(
  input: ExecuteToolUseInput,
  skillName: string,
  artifacts: SkillArtifactLike[]
): Promise<Array<{ path: string; artifact_type: string; metadata: Record<string, unknown> | undefined }>> {
  const persistedArtifacts: Array<{ path: string; artifact_type: string; metadata: Record<string, unknown> | undefined }> = [];

  for (const artifact of artifacts) {
    const absolutePath = resolveArtifactPath(input.workspaceRoot, artifact.path);
    const artifactType = artifact.artifactType?.trim() || inferArtifactType(absolutePath);
    await input.persistence.createArtifact({
      artifactType,
      path: absolutePath,
      metadataJson: artifact.metadata
    });
    await input.persistence.appendRunEvent("artifact.created", "info", {
      tool: skillName,
      tool_use_id: input.block.id,
      path: absolutePath,
      artifact_type: artifactType
    });

    persistedArtifacts.push({
      path: absolutePath,
      artifact_type: artifactType,
      metadata: artifact.metadata
    });
  }

  return persistedArtifacts;
}

async function persistSkillEvents(
  input: ExecuteToolUseInput,
  skillName: string,
  events: SkillEventLike[]
): Promise<void> {
  for (const event of events) {
    await input.persistence.appendRunEvent("tool.result", mapSkillEventLevel(event.level), {
      tool: skillName,
      tool_use_id: input.block.id,
      skill_event_type: event.type,
      ...(event.payload ? { payload: event.payload } : {})
    });
  }
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

  if (input.block.name === "send_email") {
    if (!input.emailAdapter) {
      const message = "Email adapter is not configured.";
      const toolResult = buildToolResult(
        input.block.id,
        {
          ok: false,
          error: "email_adapter_unconfigured",
          tool: input.block.name,
          message
        },
        true
      );
      await emitToolResult(input.persistence, {
        tool: input.block.name,
        tool_use_id: input.block.id,
        error: "email_adapter_unconfigured",
        message
      });
      return {
        toolResult,
        policyDenied: false
      };
    }

    if (
      input.emailSendPolicy &&
      input.emailSendPolicy.maxSends > 0 &&
      input.emailSendPolicy.sendsUsed >= input.emailSendPolicy.maxSends
    ) {
      const message = `Email send limit reached for this run (${input.emailSendPolicy.maxSends}).`;
      const toolResult = buildToolResult(
        input.block.id,
        {
          ok: false,
          error: "email_send_limit_exceeded",
          tool: input.block.name,
          message
        },
        true
      );
      await emitToolResult(input.persistence, {
        tool: input.block.name,
        tool_use_id: input.block.id,
        error: "email_send_limit_exceeded",
        message
      });
      await input.persistence.appendRunEvent("policy.denied", "warn", {
        reason: "email_send_limit",
        message,
        max_sends: input.emailSendPolicy.maxSends
      });
      return {
        toolResult,
        policyDenied: true
      };
    }

    if (input.emailSendPolicy) {
      input.emailSendPolicy.sendsUsed += 1;
    }

    const runId = input.runId ?? input.block.id;
    const payload = input.block.input ?? {};
    const result = await input.emailAdapter.run({
      runId,
      payload
    });
    const emailOutput = isRecord(result.output) ? result.output : {};
    const metadata = {
      success: result.ok,
      detail: result.detail,
      subject: typeof payload.subject === "string" ? payload.subject : undefined,
      from: typeof payload.from === "string" ? payload.from : undefined,
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      messageId: typeof emailOutput.messageId === "string" ? emailOutput.messageId : undefined,
      accepted: Array.isArray(emailOutput.accepted) ? emailOutput.accepted : undefined,
      rejected: Array.isArray(emailOutput.rejected) ? emailOutput.rejected : undefined
    };

    await input.persistence.createArtifact({
      artifactType: "email",
      path: `email-${input.runId}-${input.block.id}.json`,
      metadataJson: metadata
    });

    await emitToolResult(input.persistence, {
      tool: input.block.name,
      tool_use_id: input.block.id,
      ok: result.ok,
      subject: metadata.subject,
      message_id: metadata.messageId,
      accepted: metadata.accepted,
      rejected: metadata.rejected
    });

    return {
      toolResult: buildToolResult(
        input.block.id,
        {
          ok: result.ok,
          tool: input.block.name,
          ...(result.ok
            ? {}
            : {
                error: "email_send_failed",
                message: result.detail
              }),
          subject: metadata.subject,
          from: metadata.from,
          to: metadata.to,
          cc: metadata.cc,
          bcc: metadata.bcc,
          accepted: metadata.accepted,
          rejected: metadata.rejected,
          message_id: metadata.messageId,
          detail: result.detail
        },
        !result.ok
      ),
      policyDenied: false
    };
  }

  if (input.block.name === "send_slack_message") {
    if (!input.slackAdapter) {
      const message = "Slack adapter is not configured.";
      const toolResult = buildToolResult(
        input.block.id,
        {
          ok: false,
          error: "slack_adapter_unconfigured",
          tool: input.block.name,
          message
        },
        true
      );
      await emitToolResult(input.persistence, {
        tool: input.block.name,
        tool_use_id: input.block.id,
        error: "slack_adapter_unconfigured",
        message
      });
      return {
        toolResult,
        policyDenied: false
      };
    }

    if (
      input.slackSendPolicy &&
      input.slackSendPolicy.maxSends > 0 &&
      input.slackSendPolicy.sendsUsed >= input.slackSendPolicy.maxSends
    ) {
      const message = `Slack send limit reached for this run (${input.slackSendPolicy.maxSends}).`;
      const toolResult = buildToolResult(
        input.block.id,
        {
          ok: false,
          error: "slack_send_limit_exceeded",
          tool: input.block.name,
          message
        },
        true
      );
      await emitToolResult(input.persistence, {
        tool: input.block.name,
        tool_use_id: input.block.id,
        error: "slack_send_limit_exceeded",
        message
      });
      await input.persistence.appendRunEvent("policy.denied", "warn", {
        reason: "slack_send_limit",
        message,
        max_sends: input.slackSendPolicy.maxSends
      });
      return {
        toolResult,
        policyDenied: true
      };
    }

    if (input.slackSendPolicy) {
      input.slackSendPolicy.sendsUsed += 1;
    }

    const runId = input.runId ?? input.block.id;
    const payload = input.block.input ?? {};
    const result = await input.slackAdapter.run({
      runId,
      payload
    });
    const slackOutput = isRecord(result.output) ? result.output : {};
    const metadata = {
      success: result.ok,
      detail: result.detail,
      channel: typeof slackOutput.channel === "string" ? slackOutput.channel : payload.channel,
      messageTs:
        typeof slackOutput.message_ts === "string"
          ? slackOutput.message_ts
          : typeof slackOutput.ts === "string"
            ? slackOutput.ts
            : undefined,
      transport: typeof slackOutput.transport === "string" ? slackOutput.transport : undefined,
      text: typeof payload.text === "string" ? payload.text : undefined
    };

    await input.persistence.createArtifact({
      artifactType: "slack",
      path: `slack-${runId}-${input.block.id}.json`,
      metadataJson: metadata
    });

    await emitToolResult(input.persistence, {
      tool: input.block.name,
      tool_use_id: input.block.id,
      ok: result.ok,
      channel: metadata.channel,
      message_ts: metadata.messageTs,
      transport: metadata.transport
    });

    return {
      toolResult: buildToolResult(
        input.block.id,
        {
          ok: result.ok,
          tool: input.block.name,
          ...(result.ok
            ? {}
            : {
                error: "slack_send_failed",
                message: result.detail
              }),
          channel: metadata.channel,
          message_ts: metadata.messageTs,
          transport: metadata.transport,
          detail: result.detail
        },
        !result.ok
      ),
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

  const skill = input.skillRegistry?.get(input.block.name);
  if (skill) {
    try {
      const baseContext = input.skillExecutionContext ?? {
        workspacePath: input.workspaceRoot,
        runId: input.block.id,
        adapters: {},
        repo: {}
      };
      const skillResult = normalizeSkillResult(await skill.execute(input.block.input, baseContext));
      const persistedArtifacts = await persistSkillArtifacts(input, skill.name, skillResult.artifacts);
      await persistSkillEvents(input, skill.name, skillResult.events);

      await emitToolResult(input.persistence, {
        tool: skill.name,
        tool_use_id: input.block.id,
        ok: skillResult.ok,
        artifact_count: persistedArtifacts.length,
        event_count: skillResult.events.length
      });

      return {
        toolResult: buildToolResult(input.block.id, {
          ok: skillResult.ok,
          tool: skill.name,
          output: skillResult.output,
          artifacts: persistedArtifacts,
          events: skillResult.events
        }, !skillResult.ok),
        artifactPath: persistedArtifacts[0]?.path,
        policyDenied: false
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Skill execution failed.";

      await emitToolResult(input.persistence, {
        tool: input.block.name,
        tool_use_id: input.block.id,
        error: "skill_execution_failed",
        message
      });

      return {
        toolResult: buildToolResult(input.block.id, {
          ok: false,
          error: "skill_execution_failed",
          tool: input.block.name,
          message
        }, true),
        policyDenied: false
      };
    }
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
