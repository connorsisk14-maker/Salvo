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
  parseContractPolicy,
  resolveRunnerLlmConfig,
  validateRunnerContract
} from "./runtime";
import { runAgentLoop } from "./agent-loop";

await initializeSecrets();

const defaultEmailSendLimit = Number(process.env.SALVO_EMAIL_MAX_SENDS_PER_RUN ?? 3);
const agentLoopCheckpointKey = "agent_loop_v1";

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
  const resumeCheckpoint = await repo.loadRunCheckpoint(run.id, agentLoopCheckpointKey);
  const resumeFromCheckpoint = run.status === "running" && resumeCheckpoint !== null;
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

  if (resumeFromCheckpoint) {
    await repo.updateRunExecutionState(run.id, {
      runnerPid: process.pid,
      heartbeatAt: new Date()
    });
    await repo.appendRunEvent(run.id, "run.resumed", "info", {
      run_id: run.id,
      task_id: task.id,
      workspace: workspaceRoot,
      checkpoint_key: agentLoopCheckpointKey
    });
    logger.info("run resumed from checkpoint", {
      task_id: task.id,
      agent_profile: run.agent_profile,
      workspace: workspaceRoot,
      checkpoint_key: agentLoopCheckpointKey
    });
  } else {
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
  }

  const heartbeatTimer = setInterval(async () => {
    await repo.recordHeartbeat(run.id);
    await repo.appendRunEvent(run.id, "run.heartbeat", "debug", {
      at: new Date().toISOString()
    });
  }, 10_000);
  const emailSendPolicy = {
    maxSends:
      Number.isFinite(defaultEmailSendLimit) && defaultEmailSendLimit > 0
        ? Math.floor(defaultEmailSendLimit)
        : 3,
    sendsUsed: 0
  };

  try {
    const llmClient = new LlmClient(llmConfig);
    const loopResult = await runAgentLoop({
      provider: llmConfig.provider,
      model: llmConfig.model,
      systemPrompt: prompts.systemPrompt,
      userPrompt: prompts.userPrompt,
      contract: contractJson,
      workspaceRoot,
      startedAtMs: run.started_at ? Date.parse(run.started_at) : undefined,
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
        ).then(() => undefined),
      loadCheckpoint: async () => {
        const state = await repo.loadRunCheckpoint(run.id, agentLoopCheckpointKey);
        return state as import("./agent-loop").AgentLoopCheckpointState | null;
      },
      saveCheckpoint: (state) =>
        repo.saveRunCheckpoint(run.id, agentLoopCheckpointKey, state).then(() => undefined),
      deleteCheckpoint: () =>
        repo.deleteRunCheckpoint(run.id, agentLoopCheckpointKey)
    });

    const finalLevel = loopResult.finalPayload.status === "completed" ? "info" : "error";
    await repo.deleteRunCheckpoint(run.id, agentLoopCheckpointKey);
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
