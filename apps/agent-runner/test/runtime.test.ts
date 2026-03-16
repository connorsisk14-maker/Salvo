import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRunnerPrompts,
  normalizeArtifacts,
  parseRunnerModelOutput,
  reserveToolCall,
  resolveRunnerLlmConfig,
  validateRunnerContract
} from "../src/runtime";

test("resolveRunnerLlmConfig prefers integration config over env", () => {
  const config = resolveRunnerLlmConfig({
    integrationConfigs: [
      {
        integration_key: "llm_api",
        config_json: {
          provider: "openai",
          apiKey: "db-key",
          baseUrl: "https://example.com/v1",
          defaultModel: "gpt-5-mini"
        },
        updated_at: new Date().toISOString()
      }
    ],
    env: {
      SALVO_LLM_API_KEY: "env-key",
      SALVO_LLM_PROVIDER: "anthropic"
    },
    agentProfile: "builder"
  });

  assert.equal(config.provider, "openai");
  assert.equal(config.apiKey, "db-key");
  assert.equal(config.baseUrl, "https://example.com/v1");
  assert.equal(config.model, "gpt-5-mini");
});

test("parseRunnerModelOutput strips fenced json and validates content", () => {
  const output = parseRunnerModelOutput(`\`\`\`json
  {
    "plan_steps": ["Review contract", "Write artifact"],
    "summary": "# Summary\\n\\nDone.",
    "artifacts": [{"path":"run-summary.md","content":"# Summary\\n\\nDone."}],
    "learnings": [{"type":"best_practice","title":"Keep scope tight","body":"Use contract constraints."}]
  }
  \`\`\``);

  assert.equal(output.plan_steps.length, 2);
  assert.equal(output.artifacts[0]?.path, "run-summary.md");
  assert.equal(output.learnings[0]?.title, "Keep scope tight");
});

test("normalizeArtifacts ensures required contract deliverables exist", () => {
  const contract = validateRunnerContract({
    schema_version: 1,
    contract_id: "d7f0c34d-954a-4ab1-a495-88e6b3f61073",
    task_id: "abf16ef2-9f8b-4024-a0b2-4e4b8f5ec3d2",
    workspace_id: "fa2ef394-0fa2-4a28-85a4-3977ab2a06c1",
    created_at: new Date().toISOString(),
    objective: { primary: "Write summary", secondary: [], non_goals: [] },
    context: { relevant_files: [], recent_runs: [], memory_excerpt_ids: [] },
    scope: { read_paths: ["."], write_paths: ["."], forbidden_paths: [".git"] },
    capabilities: {
      filesystem_read: true,
      filesystem_write: true,
      run_tests: true,
      install_packages: false,
      network_access: false,
      db_read: true,
      db_write: false
    },
    constraints: {
      max_runtime_minutes: 25,
      max_tool_calls: 20,
      no_destructive_commands: true,
      approval_required_for: []
    },
    deliverables: {
      required_artifacts: ["run-summary.md"],
      evidence_required: true,
      summary_required: true
    },
    success_criteria: {
      required_test_commands: [],
      assertions: []
    },
    failure_handling: { stop_on_policy_denial: true },
    learnings_output: { required: true },
    risk: "low",
    category: "general",
    family_key: "family_test",
    agent_profile: "builder"
  });

  const artifacts = normalizeArtifacts(
    {
      plan_steps: [],
      summary: "# Summary\n\nDone.",
      artifacts: [],
      learnings: []
    },
    contract
  );

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.path, "run-summary.md");
});

test("buildRunnerPrompts includes contract and workspace context", () => {
  const contract = validateRunnerContract({
    schema_version: 1,
    contract_id: "d7f0c34d-954a-4ab1-a495-88e6b3f61073",
    task_id: "abf16ef2-9f8b-4024-a0b2-4e4b8f5ec3d2",
    workspace_id: "fa2ef394-0fa2-4a28-85a4-3977ab2a06c1",
    created_at: new Date().toISOString(),
    objective: { primary: "Write summary", secondary: [], non_goals: [] },
    context: { relevant_files: ["README.md"], recent_runs: [], memory_excerpt_ids: [] },
    scope: { read_paths: ["."], write_paths: ["."], forbidden_paths: [".git"] },
    capabilities: {
      filesystem_read: true,
      filesystem_write: true,
      run_tests: true,
      install_packages: false,
      network_access: false,
      db_read: true,
      db_write: false
    },
    constraints: {
      max_runtime_minutes: 25,
      max_tool_calls: 20,
      no_destructive_commands: true,
      approval_required_for: []
    },
    deliverables: {
      required_artifacts: ["run-summary.md"],
      evidence_required: true,
      summary_required: true
    },
    success_criteria: {
      required_test_commands: [],
      assertions: []
    },
    failure_handling: { stop_on_policy_denial: true },
    learnings_output: { required: true },
    risk: "low",
    category: "general",
    family_key: "family_test",
    agent_profile: "builder"
  });

  const prompts = buildRunnerPrompts({
    task: {
      id: "task-1",
      title: "Summarize run",
      original_request: "Create a markdown summary."
    },
    run: {
      id: "run-1",
      agent_profile: "builder"
    },
    contract,
    context: {
      workspace_listing: "file: README.md",
      relevant_files: [{ path: "README.md", content: "# Readme" }]
    }
  });

  assert.equal(prompts.systemPrompt.includes("strict JSON object"), true);
  assert.equal(prompts.userPrompt.includes("file: README.md"), true);
  assert.equal(prompts.userPrompt.includes("\"required_artifacts\""), true);
});

test("reserveToolCall throws once the contract budget is exceeded", () => {
  const first = reserveToolCall(0, 2, "llm");
  const second = reserveToolCall(first, 2, "filesystem.write");

  assert.equal(second, 2);
  assert.throws(() => reserveToolCall(second, 2, "command"), /Tool call limit exceeded/);
});
