import assert from "node:assert/strict";
import test from "node:test";
import type { LlmResponse } from "@salvo/llm";
import {
  buildContractPlanningPrompts,
  buildHeuristicContract,
  planContract,
  resolveContractPlannerConfig
} from "../src/contract-planner";

const baseTask = {
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  title: "Tighten task-specific test coverage",
  original_request: "Add focused integration coverage for the orchestrator planning path."
};

const baseWorkspace = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "default",
  local_path: "/repo/salvo"
};

test("buildContractPlanningPrompts includes workspace context and family memory", () => {
  const baseContract = buildHeuristicContract({
    contractId: "33333333-3333-4333-8333-333333333333",
    taskId: baseTask.id,
    workspaceId: baseTask.workspace_id,
    request: baseTask.original_request,
    taskTitle: baseTask.title
  });

  const prompts = buildContractPlanningPrompts({
    task: baseTask,
    workspace: baseWorkspace,
    baseContract,
    workspaceEntries: ["dir:apps", "dir:packages", "file:README.md"],
    memories: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        title: "coverage memory",
        summary: "Tests should stay focused on malformed planner responses.",
        body_markdown: "Use deterministic fallback coverage.",
        confidence: 0.9,
        review_status: "accepted",
        source_run_ids: ["55555555-5555-4555-8555-555555555555"]
      }
    ]
  });

  assert.ok(prompts.system.includes("ContractV1"));
  assert.ok(prompts.user.includes("/repo/salvo"));
  assert.ok(prompts.user.includes("dir:apps"));
  assert.ok(prompts.user.includes("coverage memory"));
  assert.ok(prompts.user.includes(baseContract.family_key));
});

test("planContract returns validated LLM contract when response is well formed", async () => {
  const baseContract = buildHeuristicContract({
    contractId: "33333333-3333-4333-8333-333333333333",
    taskId: baseTask.id,
    workspaceId: baseTask.workspace_id,
    request: baseTask.original_request,
    taskTitle: baseTask.title
  });

  const llmResponse: LlmResponse = {
    provider: "anthropic",
    model: "claude-3-5-sonnet-latest",
    usage: {
      inputTokens: 100,
      outputTokens: 200
    },
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ...baseContract,
          risk: "medium",
          scope: {
            read_paths: ["apps/orchestrator-daemon", "packages/contracts"],
            write_paths: ["apps/orchestrator-daemon", "packages/contracts"],
            forbidden_paths: [".env", ".git", "node_modules", "dist"]
          },
          success_criteria: {
            required_test_commands: ["pnpm --filter @salvo/orchestrator-daemon test"],
            assertions: ["Planner falls back when JSON is malformed."]
          }
        })
      }
    ],
    raw: {}
  };

  const result = await planContract({
    task: baseTask,
    workspace: baseWorkspace,
    baseContract,
    workspaceEntries: ["dir:apps"],
    memories: [],
    llmConfig: {
      provider: "anthropic",
      apiKey: "key",
      baseUrl: "https://api.anthropic.com",
      model: "claude-3-5-sonnet-latest"
    },
    client: {
      async createMessage() {
        return llmResponse;
      }
    }
  });

  assert.equal(result.source, "llm");
  assert.equal(result.contract.risk, "medium");
  assert.deepEqual(result.contract.scope.read_paths, [
    "apps/orchestrator-daemon",
    "packages/contracts"
  ]);
  assert.deepEqual(result.contract.success_criteria.required_test_commands, [
    "pnpm --filter @salvo/orchestrator-daemon test"
  ]);
});

test("planContract falls back to heuristic contract for malformed LLM output", async () => {
  const baseContract = buildHeuristicContract({
    contractId: "33333333-3333-4333-8333-333333333333",
    taskId: baseTask.id,
    workspaceId: baseTask.workspace_id,
    request: baseTask.original_request,
    taskTitle: baseTask.title
  });

  const result = await planContract({
    task: baseTask,
    workspace: baseWorkspace,
    baseContract,
    workspaceEntries: [],
    memories: [],
    llmConfig: {
      provider: "anthropic",
      apiKey: "key",
      baseUrl: "https://api.anthropic.com",
      model: "claude-3-5-sonnet-latest"
    },
    client: {
      async createMessage() {
        return {
          provider: "anthropic",
          model: "claude-3-5-sonnet-latest",
          usage: {
            inputTokens: 1,
            outputTokens: 1
          },
          content: [{ type: "text", text: "not valid json" }],
          raw: {}
        };
      }
    }
  });

  assert.equal(result.source, "fallback");
  assert.equal(result.contract.family_key, baseContract.family_key);
  assert.ok(result.reason?.length);
});

test("resolveContractPlannerConfig returns null when anthropic is unavailable", () => {
  const none = resolveContractPlannerConfig({
    integrationConfigs: [],
    env: {}
  });
  assert.equal(none, null);

  const openAiOnly = resolveContractPlannerConfig({
    integrationConfigs: [
      {
        integration_key: "llm_api",
        config_json: {
          provider: "openai",
          apiKey: "key",
          defaultModel: "gpt-5"
        },
        updated_at: new Date().toISOString()
      }
    ],
    env: {}
  });
  assert.equal(openAiOnly, null);
});
