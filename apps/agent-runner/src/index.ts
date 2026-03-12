import path from "node:path";
import { mkdir } from "node:fs/promises";
import { createDbPool, SalvoRepository } from "@salvo/db";
import {
  buildToolPolicy,
  CommandAdapter,
  FilesystemAdapter,
  type ToolPolicy
} from "@salvo/tools";

const MODEL_BY_PROFILE = {
  builder: "gpt-5-mini",
  researcher: "gpt-5",
  debugger: "gpt-5-mini",
  documenter: "gpt-5-nano"
} as const;

const MODEL_PRICING_USD_PER_1K = {
  "gpt-5": { input: 0.005, output: 0.015 },
  "gpt-5-mini": { input: 0.0015, output: 0.006 },
  "gpt-5-nano": { input: 0.0005, output: 0.002 }
} as const;

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }
  return process.argv[idx + 1];
}

function parseContractPolicy(
  workspaceRoot: string,
  contractJson: Record<string, unknown>
): ToolPolicy {
  const scope =
    (contractJson.scope as
      | { read_paths?: string[]; write_paths?: string[]; forbidden_paths?: string[] }
      | undefined) ?? {};

  const capabilities =
    (contractJson.capabilities as { run_tests?: boolean } | undefined) ?? {};

  const allowedCommands = capabilities.run_tests
    ? ["echo", "ls", "cat", "pnpm", "npm", "node"]
    : ["echo", "ls", "cat"];

  return buildToolPolicy(workspaceRoot, {
    allowedReadPaths: scope.read_paths ?? ["."],
    allowedWritePaths: scope.write_paths ?? ["."],
    forbiddenPaths: scope.forbidden_paths ?? [".git", "node_modules"],
    allowedCommandCwds: ["."],
    allowedCommands,
    commandTimeoutMs: 20_000
  });
}

function splitCommand(commandLine: string): { command: string; args: string[] } {
  const parts = commandLine.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { command: "echo", args: [] };
  }
  return {
    command: parts[0],
    args: parts.slice(1)
  };
}

async function main(): Promise<void> {
  const runId = parseArg("--run-id");
  if (!runId) {
    throw new Error("Missing --run-id");
  }

  const pool = createDbPool();
  const repo = new SalvoRepository(pool);

  const context = await repo.getRunWithContext(runId);
  if (!context) {
    throw new Error(`Run context not found for ${runId}`);
  }

  const { run, task, contract } = context;
  const workspaceRoot = path.resolve(
    process.env.SALVO_WORKSPACE_ROOT ?? process.cwd(),
    "runs",
    run.id
  );

  await mkdir(workspaceRoot, { recursive: true });

  const policy = parseContractPolicy(workspaceRoot, contract.contract_json);
  const filesystem = new FilesystemAdapter(workspaceRoot, policy);
  const command = new CommandAdapter(policy);
  const contractJson = contract.contract_json as {
    success_criteria?: { required_test_commands?: string[] };
  };
  const requiredTestCommands = contractJson.success_criteria?.required_test_commands ?? [];

  await repo.transitionRunStatus(run.id, "running", {
    runnerPid: process.pid,
    startedAt: new Date(),
    heartbeatAt: new Date()
  });
  await repo.transitionTaskStatus(task.id, "running");
  await repo.appendRunEvent(run.id, "run.started", "info", {
    run_id: run.id,
    task_id: task.id,
    workspace: workspaceRoot,
    agent_profile: run.agent_profile
  });

  const heartbeatTimer = setInterval(async () => {
    await repo.recordHeartbeat(run.id);
    await repo.appendRunEvent(run.id, "run.heartbeat", "debug", {
      at: new Date().toISOString()
    });
  }, 10_000);

  try {
    await repo.appendRunEvent(run.id, "plan.generated", "info", {
      steps: [
        "Create run summary deliverable",
        "Emit evidence command output",
        "Finalize payload"
      ]
    });

    const writeResult = await filesystem.writeFile(
      "run-summary.md",
      `# Run Summary\n\nTask: ${task.title}\n\nRequest: ${task.original_request}\n`
    );

    if (!writeResult.ok) {
      await repo.appendRunEvent(run.id, "policy.denied", "warn", {
        reason: writeResult.decision.reason,
        message: writeResult.decision.message,
        target: "run-summary.md"
      });

      await repo.appendRunEvent(run.id, "run.final_payload", "error", {
        status: "blocked",
        summary: "Run blocked by file policy",
        deliverables: [],
        evidence: {
          tests_run: [],
          command_results: []
        },
        roadblocks: [
          {
            type: "policy_denied",
            description: writeResult.decision.message
          }
        ],
        learnings: [
          {
            type: "failure_pattern",
            title: "Policy denied write",
            body: writeResult.decision.message
          }
        ]
      });

      await repo.appendRunEvent(run.id, "run.failed", "error", {
        reason: "policy_denied"
      });
      process.exitCode = 1;
      return;
    }

    await repo.createArtifact({
      runId: run.id,
      taskId: task.id,
      artifactType: "markdown",
      path: writeResult.absolutePath,
      metadataJson: {
        label: "run summary"
      }
    });

    await repo.appendRunEvent(run.id, "artifact.created", "info", {
      path: writeResult.absolutePath,
      artifact_type: "markdown"
    });

    await repo.appendRunEvent(run.id, "tool.called", "info", {
      tool: "command",
      command: "echo",
      args: ["runner evidence"]
    });

    const commandResult = await command.run("echo", ["runner evidence"], workspaceRoot);

    if (!commandResult.ok) {
      await repo.appendRunEvent(run.id, "policy.denied", "warn", {
        reason: commandResult.decision.reason,
        message: commandResult.decision.message,
        command: "echo"
      });
    } else {
      await repo.appendRunEvent(run.id, "tool.result", "info", {
        command: "echo",
        exit_code: commandResult.exitCode,
        stdout: commandResult.stdout.trim()
      });
    }

    const testsRun: Array<{ command: string; exit_code?: number; denied?: boolean }> = [];
    for (const testCommand of requiredTestCommands) {
      const parsed = splitCommand(testCommand);
      await repo.appendRunEvent(run.id, "tool.called", "info", {
        tool: "command",
        command: parsed.command,
        args: parsed.args,
        purpose: "required_test_command"
      });

      const testResult = await command.run(parsed.command, parsed.args, workspaceRoot);
      if (!testResult.ok) {
        await repo.appendRunEvent(run.id, "policy.denied", "warn", {
          reason: testResult.decision.reason,
          message: testResult.decision.message,
          command: testCommand
        });
        testsRun.push({
          command: testCommand,
          denied: true
        });
      } else {
        await repo.appendRunEvent(run.id, "tool.result", "info", {
          command: testCommand,
          exit_code: testResult.exitCode,
          stdout: testResult.stdout.trim()
        });
        testsRun.push({
          command: testCommand,
          exit_code: testResult.exitCode
        });
      }
    }

    const model = MODEL_BY_PROFILE[run.agent_profile] ?? "gpt-5-mini";
    const pricing = MODEL_PRICING_USD_PER_1K[model] ?? MODEL_PRICING_USD_PER_1K["gpt-5-mini"];
    const inputTokens = Math.max(1, Math.ceil(task.original_request.length / 4));
    const outputTokens = Math.max(1, Math.ceil((task.title.length + 120) / 4));
    const estimatedCostUsd =
      (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output;

    await repo.appendRunEvent(run.id, "usage.reported", "info", {
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: Number(estimatedCostUsd.toFixed(6)),
      pricing_unit: "usd_per_1k_tokens",
      estimated: true
    });

    await repo.appendRunEvent(run.id, "run.final_payload", "info", {
      status: "completed",
      summary: `Generated run summary for task ${task.id}`,
      deliverables: ["run-summary.md"],
      evidence: {
        tests_run: testsRun,
        command_results: [
          commandResult.ok
            ? {
                command: "echo",
                exit_code: commandResult.exitCode
              }
            : {
                command: "echo",
                denied: true,
                reason: commandResult.decision.reason
              }
        ],
        files_changed: 1
      },
      roadblocks: [],
      learnings: [
        {
          type: "best_practice",
          title: "Adapter-only execution",
          body: "Runner used only policy-enforced adapters for file and command operations."
        }
      ]
    });

    await repo.appendRunEvent(run.id, "run.completed", "info", {
      summary: "Runner completed payload emission"
    });
  } catch (error) {
    await repo.appendRunEvent(run.id, "run.failed", "error", {
      error: (error as Error).message
    });
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeatTimer);
    await repo.close();
  }
}

await main();
