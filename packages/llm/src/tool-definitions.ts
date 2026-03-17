import type { ContractV1 } from "@salvo/contracts";
import type { LlmToolDefinition } from "./types";

const READ_FILE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description: "Workspace-relative path to the target file or directory."
    }
  },
  required: ["path"]
} satisfies Record<string, unknown>;

const LIST_DIRECTORY_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description: "Workspace-relative path to the target directory. Defaults to the workspace root."
    }
  }
} satisfies Record<string, unknown>;

const WRITE_FILE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description: "Workspace-relative path to the file that should be written."
    },
    content: {
      type: "string",
      description: "UTF-8 file content to write at the target path."
    }
  },
  required: ["path", "content"]
} satisfies Record<string, unknown>;

const RUN_COMMAND_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    command: {
      type: "string",
      minLength: 1,
      description: "Executable name to run."
    },
    args: {
      type: "array",
      description: "Command arguments in execution order.",
      items: {
        type: "string"
      },
      default: []
    },
    cwd: {
      type: "string",
      minLength: 1,
      description: "Workspace-relative directory for command execution."
    }
  },
  required: ["command"]
} satisfies Record<string, unknown>;

const ROADBLOCK_SCHEMA = {
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
} satisfies Record<string, unknown>;

const TEST_RESULT_SCHEMA = {
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
} satisfies Record<string, unknown>;

const COMMAND_RESULT_SCHEMA = {
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
} satisfies Record<string, unknown>;

const LEARNING_SCHEMA = {
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
} satisfies Record<string, unknown>;

const COMPLETE_INPUT_SCHEMA = {
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
          items: TEST_RESULT_SCHEMA
        },
        command_results: {
          type: "array",
          items: COMMAND_RESULT_SCHEMA
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
      items: ROADBLOCK_SCHEMA
    },
    learnings: {
      type: "array",
      items: LEARNING_SCHEMA
    }
  },
  required: ["status", "summary", "deliverables", "evidence", "roadblocks", "learnings"]
} satisfies Record<string, unknown>;

const BASE_TOOL_DEFINITIONS = {
  read_file: {
    name: "read_file",
    description: "Read a UTF-8 file from the allowed workspace scope.",
    inputSchema: READ_FILE_INPUT_SCHEMA
  },
  list_directory: {
    name: "list_directory",
    description: "List files and directories inside an allowed workspace path.",
    inputSchema: LIST_DIRECTORY_INPUT_SCHEMA
  },
  write_file: {
    name: "write_file",
    description: "Write UTF-8 file content inside the allowed workspace scope.",
    inputSchema: WRITE_FILE_INPUT_SCHEMA
  },
  run_command: {
    name: "run_command",
    description: "Run an allowlisted command inside the allowed workspace scope.",
    inputSchema: RUN_COMMAND_INPUT_SCHEMA
  },
  salvo_complete: {
    name: "salvo_complete",
    description: "Submit the terminal run payload after the contract work is complete.",
    inputSchema: COMPLETE_INPUT_SCHEMA
  }
} satisfies Record<string, LlmToolDefinition>;

export type BuildToolDefinitionsOptions = {
  completionToolName?: string;
};

export function buildToolDefinitions(
  contract: ContractV1,
  options: BuildToolDefinitionsOptions = {}
): LlmToolDefinition[] {
  const definitions: LlmToolDefinition[] = [];
  const completionToolName = options.completionToolName?.trim() || "salvo_complete";

  if (contract.capabilities.filesystem_read) {
    definitions.push(BASE_TOOL_DEFINITIONS.read_file, BASE_TOOL_DEFINITIONS.list_directory);
  }

  if (contract.capabilities.filesystem_write) {
    definitions.push(BASE_TOOL_DEFINITIONS.write_file);
  }

  if (contract.capabilities.run_tests) {
    definitions.push(BASE_TOOL_DEFINITIONS.run_command);
  }

  definitions.push({
    ...BASE_TOOL_DEFINITIONS.salvo_complete,
    name: completionToolName
  });
  return definitions;
}
