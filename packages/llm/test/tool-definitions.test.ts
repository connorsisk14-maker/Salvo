import assert from "node:assert/strict";
import test from "node:test";
import { buildContractV1 } from "@salvo/contracts";
import { buildToolDefinitions } from "../src/index";

function buildContract() {
  return buildContractV1({
    contractId: "11111111-1111-4111-8111-111111111111",
    taskId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    request: "Create a markdown report and run validation tests.",
    taskTitle: "Generate report"
  });
}

function toolNames(contract = buildContract()): string[] {
  return buildToolDefinitions(contract).map((tool) => tool.name);
}

test("buildToolDefinitions includes the default tool set for a writable contract", () => {
  assert.deepEqual(toolNames(), [
    "read_file",
    "list_directory",
    "write_file",
    "run_command",
    "salvo_complete"
  ]);
});

test("buildToolDefinitions removes read tools when filesystem read is denied", () => {
  const contract = buildContract();
  contract.capabilities.filesystem_read = false;

  assert.deepEqual(toolNames(contract), ["write_file", "run_command", "salvo_complete"]);
});

test("buildToolDefinitions removes write_file when filesystem write is denied", () => {
  const contract = buildContract();
  contract.capabilities.filesystem_write = false;

  assert.deepEqual(toolNames(contract), ["read_file", "list_directory", "run_command", "salvo_complete"]);
});

test("buildToolDefinitions removes run_command when command execution is denied", () => {
  const contract = buildContract();
  contract.capabilities.run_tests = false;

  assert.deepEqual(toolNames(contract), ["read_file", "list_directory", "write_file", "salvo_complete"]);
});

test("buildToolDefinitions adds send_email when email_send capability is enabled", () => {
  const contract = buildContract();
  contract.capabilities.email_send = true;

  assert.deepEqual(toolNames(contract), [
    "read_file",
    "list_directory",
    "write_file",
    "run_command",
    "send_email",
    "salvo_complete"
  ]);
});

test("buildToolDefinitions adds send_slack_message when slack_send capability is enabled", () => {
  const contract = buildContract();
  contract.capabilities.slack_send = true;

  assert.deepEqual(toolNames(contract), [
    "read_file",
    "list_directory",
    "write_file",
    "run_command",
    "send_slack_message",
    "salvo_complete"
  ]);
});

test("buildToolDefinitions always includes salvo_complete", () => {
  const contract = buildContract();
  contract.capabilities.filesystem_read = false;
  contract.capabilities.filesystem_write = false;
  contract.capabilities.run_tests = false;
  contract.capabilities.install_packages = false;
  contract.capabilities.network_access = false;
  contract.capabilities.db_read = false;
  contract.capabilities.db_write = false;

  const definitions = buildToolDefinitions(contract);

  assert.deepEqual(
    definitions.map((tool) => tool.name),
    ["salvo_complete"]
  );
  assert.deepEqual(definitions[0]?.inputSchema, {
    type: "object",
    additionalProperties: false,
    properties: {
      status: {
        type: "string",
        enum: ["completed", "blocked", "failed"],
        description: "Terminal run outcome."
      },
      summary: {
        type: "string",
        minLength: 1,
        description: "Concise execution summary."
      },
      deliverables: {
        type: "array",
        description: "List of produced artifact paths or labels.",
        items: {
          type: "string",
          minLength: 1
        }
      },
      evidence: {
        type: "object",
        additionalProperties: false,
        description: "Structured evidence supporting the final result.",
        properties: {
          tests_run: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                command: {
                  type: "string",
                  minLength: 1
                },
                exit_code: {
                  type: "integer"
                },
                denied: {
                  type: "boolean"
                }
              },
              required: ["command"]
            }
          },
          command_results: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                command: {
                  type: "string",
                  minLength: 1
                },
                exit_code: {
                  type: "integer"
                },
                stdout: {
                  type: "string"
                },
                stderr: {
                  type: "string"
                },
                duration_ms: {
                  type: "integer"
                },
                denied: {
                  type: "boolean"
                },
                reason: {
                  type: "string"
                },
                message: {
                  type: "string"
                }
              },
              required: ["command"]
            }
          },
          files_changed: {
            type: "integer",
            minimum: 0
          }
        },
        required: ["tests_run", "command_results", "files_changed"]
      },
      roadblocks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: {
              type: "string",
              minLength: 1
            },
            description: {
              type: "string",
              minLength: 1
            }
          },
          required: ["type", "description"]
        }
      },
      learnings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: {
              type: "string",
              minLength: 1
            },
            title: {
              type: "string",
              minLength: 1
            },
            body: {
              type: "string",
              minLength: 1
            }
          },
          required: ["type", "title", "body"]
        }
      }
    },
    required: ["status", "summary", "deliverables", "evidence", "roadblocks", "learnings"]
  });
});

test("buildToolDefinitions allows overriding the completion tool name", () => {
  const definitions = buildToolDefinitions(buildContract(), {
    completionToolName: "submit_result"
  });

  assert.equal(definitions.at(-1)?.name, "submit_result");
});

test("buildToolDefinitions appends registered skills before completion", () => {
  const definitions = buildToolDefinitions(buildContract(), {
    skillRegistry: {
      list() {
        return [
          {
            name: "generate_summary",
            description: "Generate summary output.",
            inputSchema: {
              type: "object",
              properties: {
                prompt: {
                  type: "string"
                }
              },
              required: ["prompt"]
            }
          }
        ];
      }
    }
  });

  assert.deepEqual(
    definitions.map((tool) => tool.name),
    ["read_file", "list_directory", "write_file", "run_command", "generate_summary", "salvo_complete"]
  );
});

test("buildToolDefinitions skips skill names that collide with reserved tools", () => {
  const definitions = buildToolDefinitions(buildContract(), {
    completionToolName: "submit_result",
    skillRegistry: {
      list() {
        return [
          {
            name: "run_command",
            description: "duplicate built-in",
            inputSchema: { type: "object" }
          },
          {
            name: "submit_result",
            description: "duplicate completion",
            inputSchema: { type: "object" }
          },
          {
            name: "team_sync",
            description: "sync team status",
            inputSchema: { type: "object" }
          }
        ];
      }
    }
  });

  assert.deepEqual(
    definitions.map((tool) => tool.name),
    ["read_file", "list_directory", "write_file", "run_command", "team_sync", "submit_result"]
  );
});
