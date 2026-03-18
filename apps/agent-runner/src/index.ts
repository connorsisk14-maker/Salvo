import path from "node:path";
import { mkdir } from "node:fs/promises";
import { EmailAdapter } from "@salvo/adapters";
import { createDbPool, SalvoRepository } from "@salvo/db";
import { buildToolDefinitions, executeToolUse, LlmClient } from "@salvo/llm";
import { CommandAdapter, FilesystemAdapter } from "@salvo/tools";
import { createLogger, initializeSecrets, type RunEventType } from "@salvo/shared";
import {
  buildRunnerPrompts,
  collectPromptContext,
  commandEvidence,
  type RunnerUsage,
  normalizeArtifacts,
  parseContractPolicy,
  reserveToolCall,
  resolveRunnerLlmConfig,
  runLlmGeneration,
  validateRunnerContract
} from "./runtime";
import { runAgentLoop } from "./agent-loop";

await initializeSecrets();

const defaultEmailSendLimit = Number(process.env.SALVO_EMAIL_MAX_SENDS_PER_RUN ?? 3);

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }
  return process.argv[idx + 1];
}

function readIntegrationString(config: Record<string, unknown>, key: string, fallback = ""): string {
  const value = config[key];
  return typeof value === "string" ? value.trim() : fallback;
}

function readIntegrationStringList(config: Record<string, unknown>, key: string): string[] {
  const value = config[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : []
  );
}

function detectUsageLimitViolation(
  usage: RunnerUsage,
  constraints: {
    max_total_input_tokens: number;
    max_total_output_tokens: number;
    max_total_cost_usd: number;
  }
): { reason: string; message: string; payload: Record<string, unknown> } | null {
  if (usage.input_tokens > constraints.max_total_input_tokens) {
    return {
      reason: "max_total_input_tokens",
      message: `Run exceeded the input token limit of ${constraints.max_total_input_tokens}.`,
      payload: {
        limit_name: "max_total_input_tokens",
        limit: constraints.max_total_input_tokens,
        observed: usage.input_tokens
      }
    };
  }

  if (usage.output_tokens > constraints.max_total_output_tokens) {
    return {
      reason: "max_total_output_tokens",
      message: `Run exceeded the output token limit of ${constraints.max_total_output_tokens}.`,
      payload: {
        limit_name: "max_total_output_tokens",
        limit: constraints.max_total_output_tokens,
        observed: usage.output_tokens
      }
    };
  }

  if (usage.cost_usd > constraints.max_total_cost_usd) {
    return {
      reason: "max_total_cost_usd",
      message: `Run exceeded the cost limit of $${constraints.max_total_cost_usd.toFixed(2)}.`,
      payload: {
        limit_name: "max_total_cost_usd",
        limit: constraints.max_total_cost_usd,
        observed: Number(usage.cost_usd.toFixed(6))
      }
    };
  }

  return null;
}

async function main(): Promise<void> {
  const runId = parseArg("--run-id");
  if (!runId) {
    throw new Error("Missing --run-id");
  }

  const logger = createLogger({
    component: "agent-runner",
    run_id: runId
  });

  const pool = createDbPool();
  const repo = new SalvoRepository(pool);

  const context = await repo.getRunWithContext(runId);
  if (!context) {
    throw new Error(`Run context not found for ${runId}`);
  }

  const { run, task, contract } = context;
  const contractJson = validateRunnerContract(contract.contract_json);
  const integrationConfigs = await repo.listIntegrationConfigs();
  const llmConfig = resolveRunnerLlmConfig({
    integrationConfigs,
    env: process.env,
    agentProfile: run.agent_profile
  });
  const workspaceRoot = path.resolve(
    process.env.SALVO_WORKSPACE_ROOT ?? process.cwd(),
    "runs",
    run.id
  );

  await mkdir(workspaceRoot, { recursive: true });

  const policy = parseContractPolicy(workspaceRoot, contractJson);
  const filesystem = new FilesystemAdapter(workspaceRoot, policy);
  const command = new CommandAdapter(policy);
  const emailConfig =
    integrationConfigs.find((row) => row.integration_key === "email")?.config_json ?? {};
  const transportUrl =
    readIntegrationString(emailConfig, "transportUrl") ||
    readIntegrationString(emailConfig, "transport_url");
  const emailAdapter = transportUrl
    ? new EmailAdapter({
        transportUrl,
        defaultFrom:
          readIntegrationString(emailConfig, "defaultFrom") ||
          readIntegrationString(emailConfig, "default_from"),
        defaultRecipients: [
          ...readIntegrationStringList(emailConfig, "defaultRecipients"),
          ...readIntegrationStringList(emailConfig, "default_recipients")
        ]
      })
    : undefined;
  const promptContext = await collectPromptContext({
    relevantFiles: contractJson.context.relevant_files,
    listDirectory: (targetPath) => filesystem.listDirectory(targetPath),
    readFile: (targetPath) => filesystem.readFile(targetPath)
  });
  const prompts = buildRunnerPrompts({
    task,
    run,
    contract: contractJson,
    context: promptContext
  });

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
    agent_profile: run.agent_profile,
    model: llmConfig.model,
    provider: llmConfig.provider
  });
  logger.info("run started", {
    task_id: task.id,
    agent_profile: run.agent_profile,
    workspace: workspaceRoot,
    model: llmConfig.model,
    provider: llmConfig.provider
  });

  const heartbeatTimer = setInterval(async () => {
    await repo.recordHeartbeat(run.id);
    await repo.appendRunEvent(run.id, "run.heartbeat", "debug", {
      at: new Date().toISOString()
    });
  }, 10_000);
  let toolCallsUsed = 0;
  const emailSendPolicy = {
    maxSends:
      Number.isFinite(defaultEmailSendLimit) && defaultEmailSendLimit > 0
        ? Math.floor(defaultEmailSendLimit)
        : 3,
    sendsUsed: 0
  };

  const trackToolCall = async (payload: Record<string, unknown>) => {
    try {
      toolCallsUsed = reserveToolCall(
        toolCallsUsed,
        contractJson.constraints.max_tool_calls,
        String(payload.tool ?? "unknown")
      );
    } catch (error) {
      await repo.appendRunEvent(run.id, "policy.denied", "warn", {
        reason: "tool_call_limit",
        message: (error as Error).message,
        max_tool_calls: contractJson.constraints.max_tool_calls,
        tool_calls_used: toolCallsUsed,
        ...payload
      });
      throw error;
    }

    await repo.appendRunEvent(run.id, "tool.called", "info", payload);
  };

  try {
    if (llmConfig.provider === "anthropic") {
      const llmClient = new LlmClient(llmConfig);
      const loopResult = await runAgentLoop({
        provider: llmConfig.provider,
        model: llmConfig.model,
        systemPrompt: prompts.systemPrompt,
        userPrompt: prompts.userPrompt,
        contract: contractJson,
        workspaceRoot,
        createMessage: (systemPrompt, messages) =>
          llmClient.createMessage(
            systemPrompt,
            messages,
            buildToolDefinitions(contractJson)
          ),
        executeToolUse: async (block) =>
          executeToolUse({
            block,
            workspaceRoot,
            requiredTestCommands: new Set(contractJson.success_criteria.required_test_commands),
            deps: {
              readFile: (targetPath) => filesystem.readFile(targetPath),
              writeFile: (targetPath, content) => filesystem.writeFile(targetPath, content),
              listDirectory: (targetPath) => filesystem.listDirectory(targetPath),
              runCommand: (commandName, args, cwd, timeoutMs) =>
                command.run(commandName, args, cwd, timeoutMs)
            },
            persistence: {
              appendRunEvent: (eventType, level, payload) =>
                repo.appendRunEvent(
                  run.id,
                  eventType as RunEventType,
                  level,
                  payload
                ).then(() => undefined),
              createArtifact: (params) =>
                repo.createArtifact({
                  runId: run.id,
                  taskId: task.id,
                  artifactType: params.artifactType,
                  path: params.path,
                  metadataJson: params.metadataJson
                })
            },
            emailAdapter,
            emailSendPolicy
          }),
        appendRunEvent: (eventType, level, payload) =>
          repo.appendRunEvent(
            run.id,
            eventType as RunEventType,
            level,
            payload
          ).then(() => undefined)
      });

      const finalLevel = loopResult.finalPayload.status === "completed" ? "info" : "error";
      await repo.appendRunEvent(run.id, "run.final_payload", finalLevel, loopResult.finalPayload);
      if (loopResult.finalPayload.status !== "completed") {
        await repo.appendRunEvent(run.id, "run.failed", "error", {
          reason: loopResult.exitReason
        });
        process.exitCode = 1;
      } else {
        logger.info("run completed", {
          task_id: task.id,
          deliverables: loopResult.finalPayload.deliverables
        });
      }
      return;
    }

    await trackToolCall({
      tool: "llm",
      provider: llmConfig.provider,
      model: llmConfig.model
    });

    const llmResult = await runLlmGeneration({
      config: llmConfig,
      systemPrompt: prompts.systemPrompt,
      userPrompt: prompts.userPrompt
    });

    await repo.appendRunEvent(run.id, "tool.result", "info", {
      tool: "llm",
      provider: llmConfig.provider,
      model: llmConfig.model,
      plan_steps: llmResult.output.plan_steps.length,
      artifact_count: llmResult.output.artifacts.length,
      learning_count: llmResult.output.learnings.length
    });
    await repo.appendRunEvent(run.id, "plan.generated", "info", {
      steps: llmResult.output.plan_steps
    });

    await repo.appendRunEvent(run.id, "usage.reported", "info", llmResult.usage);
    logger.info("usage reported", llmResult.usage);

    const usageLimitViolation = detectUsageLimitViolation(llmResult.usage, contractJson.constraints);
    if (usageLimitViolation) {
      await repo.appendRunEvent(run.id, "resource.limit_reached", "warn", usageLimitViolation.payload);
      await repo.appendRunEvent(run.id, "run.final_payload", "error", {
        status: "blocked",
        summary: "Agent run stopped before completion.",
        deliverables: [],
        evidence: {
          tests_run: [],
          command_results: [],
          files_changed: 0
        },
        roadblocks: [
          {
            type: "resource_limit",
            description: usageLimitViolation.message
          }
        ],
        learnings: []
      });
      await repo.appendRunEvent(run.id, "run.failed", "error", {
        reason: usageLimitViolation.reason
      });
      process.exitCode = 1;
      return;
    }

    const artifacts = normalizeArtifacts(llmResult.output, contractJson);
    const createdArtifacts: string[] = [];
    const testsRun: Array<{ command: string; exit_code?: number; denied?: boolean }> = [];
    const commandResults: Record<string, unknown>[] = [];

    for (const artifact of artifacts) {
      await trackToolCall({
        tool: "filesystem.write",
        path: artifact.path
      });

      const writeResult = await filesystem.writeFile(artifact.path, artifact.content);
      if (!writeResult.ok) {
        logger.warn("artifact write blocked by policy", {
          task_id: task.id,
          path: artifact.path,
          reason: writeResult.decision.reason
        });
        await repo.appendRunEvent(run.id, "policy.denied", "warn", {
          reason: writeResult.decision.reason,
          message: writeResult.decision.message,
          target: artifact.path
        });

        if (contractJson.failure_handling.stop_on_policy_denial) {
          await repo.appendRunEvent(run.id, "run.final_payload", "error", {
            status: "blocked",
            summary: llmResult.output.summary,
            deliverables: createdArtifacts,
            evidence: {
              tests_run: [],
              command_results: [],
              files_changed: createdArtifacts.length
            },
            roadblocks: [
              {
                type: "policy_denied",
                description: writeResult.decision.message
              }
            ],
            learnings: llmResult.output.learnings
          });
          await repo.appendRunEvent(run.id, "run.failed", "error", {
            reason: "policy_denied"
          });
          process.exitCode = 1;
          return;
        }

        continue;
      }

      await repo.createArtifact({
        runId: run.id,
        taskId: task.id,
        artifactType: artifact.artifact_type ?? "markdown",
        path: writeResult.absolutePath,
        metadataJson: {
          label: artifact.label ?? artifact.path
        }
      });
      await repo.appendRunEvent(run.id, "artifact.created", "info", {
        path: writeResult.absolutePath,
        artifact_type: artifact.artifact_type ?? "markdown"
      });
      createdArtifacts.push(artifact.path);
    }

    for (const testCommand of contractJson.success_criteria.required_test_commands) {
      const parts = testCommand.trim().split(/\s+/).filter(Boolean);
      const commandName = parts[0] ?? "echo";
      const args = parts.slice(1);

      await trackToolCall({
        tool: "command",
        command: commandName,
        args,
        purpose: "required_test_command"
      });

      const result = await command.run(commandName, args, workspaceRoot);
      commandResults.push(commandEvidence(testCommand, result));

      if (!result.ok) {
        await repo.appendRunEvent(run.id, "policy.denied", "warn", {
          reason: result.decision.reason,
          message: result.decision.message,
          command: testCommand
        });
        testsRun.push({
          command: testCommand,
          denied: true
        });
        continue;
      }

      await repo.appendRunEvent(run.id, "tool.result", "info", {
        command: testCommand,
        exit_code: result.exitCode,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        duration_ms: result.durationMs
      });
      testsRun.push({
        command: testCommand,
        exit_code: result.exitCode
      });
    }

    await repo.appendRunEvent(run.id, "run.final_payload", "info", {
      status: "completed",
      summary: llmResult.output.summary,
      deliverables: createdArtifacts,
      evidence: {
        tests_run: testsRun,
        command_results: commandResults,
        files_changed: createdArtifacts.length
      },
      roadblocks: [],
      learnings: llmResult.output.learnings
    });
    logger.info("run completed", {
      task_id: task.id,
      deliverables: createdArtifacts
    });
  } catch (error) {
    logger.error("run failed", {
      task_id: task.id,
      error
    });
    await repo.appendRunEvent(run.id, "run.failed", "error", {
      error: (error as Error).message
    });
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeatTimer);
    await repo.close();
  }
}

try {
  await main();
} catch (error) {
  createLogger({ component: "agent-runner" }).error("runner crashed", { error });
  process.exit(1);
}
