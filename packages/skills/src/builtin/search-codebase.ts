import path from "node:path";
import type { Skill, SkillExecutionContext, SkillResult } from "../types";

const DEFAULT_RESULT_CAP = 25;
const MAX_RESULT_CAP = 200;
const FORBIDDEN_SEGMENTS = new Set([".git", "node_modules"]);

export type SearchCodebaseInput = {
  pattern: string;
  path?: string;
  extensions?: string[];
  cap?: number;
  resultCap?: number;
  maxResults?: number;
};

export type SearchCodebaseMatch = {
  file: string;
  line: number;
  content: string;
};

export type SearchCodebaseOutput = {
  matches: SearchCodebaseMatch[];
  totalMatches: number;
  capped: boolean;
  cap: number;
  searchPath: string;
  pattern: string;
  errorCode?: string;
  error?: string;
};

type CommandExecutionResult =
  | {
      ok: true;
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
    }
  | {
      ok: false;
      decision: {
        reason: string;
        message: string;
      };
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      durationMs?: number;
    };

type CommandAdapterLike = {
  run(command: string, args: string[], cwd: string, timeoutMs?: number): Promise<CommandExecutionResult>;
};

type RipgrepMatchLine = {
  type: string;
  data?: {
    path?: {
      text?: string;
    };
    line_number?: number;
    lines?: {
      text?: string;
    };
  };
};

function normalizeCap(input: SearchCodebaseInput): number {
  const requested = input.maxResults ?? input.resultCap ?? input.cap ?? DEFAULT_RESULT_CAP;
  if (!Number.isFinite(requested)) {
    return DEFAULT_RESULT_CAP;
  }
  const floored = Math.floor(requested);
  if (floored < 1) {
    return 1;
  }
  return Math.min(floored, MAX_RESULT_CAP);
}

function normalizeExtensions(extensions: string[] | undefined): string[] {
  if (!extensions || extensions.length === 0) {
    return [];
  }

  const sanitized = new Set<string>();
  for (const extension of extensions) {
    const normalized = extension.trim().replace(/^\./, "").toLowerCase();
    if (!normalized) {
      continue;
    }
    if (!/^[a-z0-9_-]+$/.test(normalized)) {
      continue;
    }
    sanitized.add(normalized);
  }

  return Array.from(sanitized);
}

function getCommandAdapter(context: SkillExecutionContext): CommandAdapterLike | null {
  const adapter = (context.adapters as Record<string, unknown>).command;
  if (!adapter || typeof adapter !== "object") {
    return null;
  }
  const runFn = (adapter as { run?: unknown }).run;
  if (typeof runFn !== "function") {
    return null;
  }
  return adapter as CommandAdapterLike;
}

function resolveSearchPath(
  workspacePath: string,
  requestedPath: string | undefined
): { ok: true; absolutePath: string; relativePath: string } | { ok: false; reason: string; message: string } {
  const normalizedWorkspace = path.resolve(workspacePath);
  const resolvedPath = path.resolve(normalizedWorkspace, requestedPath ?? ".");
  const relativePath = path.relative(normalizedWorkspace, resolvedPath);
  const isOutsideWorkspace = relativePath.startsWith("..") || path.isAbsolute(relativePath);

  if (isOutsideWorkspace) {
    return {
      ok: false,
      reason: "path_not_allowlisted",
      message: `Search path ${resolvedPath} is outside workspace root ${normalizedWorkspace}.`
    };
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
    return {
      ok: false,
      reason: "forbidden_path",
      message: `Search path ${requestedPath ?? "."} includes forbidden segments.`
    };
  }

  return {
    ok: true,
    absolutePath: resolvedPath,
    relativePath: relativePath.length > 0 ? relativePath : "."
  };
}

function parseRipgrepMatches(
  stdout: string,
  workspacePath: string,
  extensions: string[]
): SearchCodebaseMatch[] {
  const matches: SearchCodebaseMatch[] = [];
  const extensionSet = new Set(extensions);

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: RipgrepMatchLine;
    try {
      parsed = JSON.parse(trimmed) as RipgrepMatchLine;
    } catch {
      continue;
    }

    if (parsed.type !== "match") {
      continue;
    }

    const filePath = parsed.data?.path?.text;
    const lineNumber = parsed.data?.line_number;
    const content = parsed.data?.lines?.text;
    if (!filePath || typeof lineNumber !== "number" || typeof content !== "string") {
      continue;
    }

    const normalizedAbsolute = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(workspacePath, filePath);
    const normalizedRelative = path.relative(workspacePath, normalizedAbsolute);

    if (normalizedRelative.startsWith("..")) {
      continue;
    }

    const extension = path.extname(normalizedRelative).replace(/^\./, "").toLowerCase();
    if (extensionSet.size > 0 && !extensionSet.has(extension)) {
      continue;
    }

    matches.push({
      file: normalizedRelative.length > 0 ? normalizedRelative : filePath,
      line: lineNumber,
      content: content.replace(/\r?\n$/, "")
    });
  }

  return matches;
}

export const searchCodebaseSkill: Skill<SearchCodebaseInput, SearchCodebaseOutput> = {
  name: "search_codebase",
  version: "1.0.0",
  description: "Search code in the workspace using ripgrep with path and extension filtering.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: {
        type: "string",
        minLength: 1
      },
      path: {
        type: "string"
      },
      extensions: {
        type: "array",
        items: {
          type: "string"
        }
      },
      cap: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RESULT_CAP
      },
      resultCap: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RESULT_CAP
      },
      maxResults: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RESULT_CAP
      }
    }
  },
  async execute(input, context): Promise<SkillResult<SearchCodebaseOutput>> {
    const pattern = input.pattern.trim();
    const cap = normalizeCap(input);
    const extensions = normalizeExtensions(input.extensions);

    if (!pattern) {
      return {
        ok: false,
        output: {
          matches: [],
          totalMatches: 0,
          capped: false,
          cap,
          searchPath: input.path ?? ".",
          pattern,
          errorCode: "invalid_input",
          error: "pattern must be non-empty"
        },
        artifacts: [],
        events: [
          {
            type: "skill.search_codebase.invalid_input",
            level: "warn",
            payload: {
              field: "pattern"
            }
          }
        ]
      };
    }

    const commandAdapter = getCommandAdapter(context);
    if (!commandAdapter) {
      return {
        ok: false,
        output: {
          matches: [],
          totalMatches: 0,
          capped: false,
          cap,
          searchPath: input.path ?? ".",
          pattern,
          errorCode: "missing_adapter",
          error: "command adapter unavailable in skill context"
        },
        artifacts: [],
        events: [
          {
            type: "skill.search_codebase.missing_adapter",
            level: "error"
          }
        ]
      };
    }

    const pathResolution = resolveSearchPath(context.workspacePath, input.path);
    if (!pathResolution.ok) {
      return {
        ok: false,
        output: {
          matches: [],
          totalMatches: 0,
          capped: false,
          cap,
          searchPath: input.path ?? ".",
          pattern,
          errorCode: pathResolution.reason,
          error: pathResolution.message
        },
        artifacts: [],
        events: [
          {
            type: "skill.search_codebase.path_blocked",
            level: "warn",
            payload: {
              reason: pathResolution.reason,
              path: input.path ?? "."
            }
          }
        ]
      };
    }

    const rgArgs = [
      "--json",
      "--line-number",
      "--color",
      "never",
      "--no-heading",
      "--glob",
      "!**/.git/**",
      "--glob",
      "!**/node_modules/**"
    ];

    for (const extension of extensions) {
      rgArgs.push("--glob", `**/*.${extension}`);
    }

    rgArgs.push(pattern, pathResolution.relativePath);

    const startedAt = Date.now();
    const commandResult = await commandAdapter.run("rg", rgArgs, context.workspacePath);
    const durationMs = Date.now() - startedAt;

    if (!commandResult.ok) {
      return {
        ok: false,
        output: {
          matches: [],
          totalMatches: 0,
          capped: false,
          cap,
          searchPath: pathResolution.relativePath,
          pattern,
          errorCode: commandResult.decision.reason,
          error: commandResult.decision.message
        },
        artifacts: [],
        events: [
          {
            type: "skill.search_codebase.command_denied",
            level: "warn",
            payload: {
              reason: commandResult.decision.reason,
              message: commandResult.decision.message
            }
          }
        ]
      };
    }

    if (commandResult.exitCode > 1) {
      return {
        ok: false,
        output: {
          matches: [],
          totalMatches: 0,
          capped: false,
          cap,
          searchPath: pathResolution.relativePath,
          pattern,
          errorCode: "search_command_failed",
          error: commandResult.stderr || `rg exited with code ${commandResult.exitCode}`
        },
        artifacts: [],
        events: [
          {
            type: "skill.search_codebase.command_failed",
            level: "error",
            payload: {
              exitCode: commandResult.exitCode,
              stderr: commandResult.stderr
            }
          }
        ]
      };
    }

    const parsedMatches = parseRipgrepMatches(commandResult.stdout, context.workspacePath, extensions);
    const totalMatches = parsedMatches.length;
    const matches = parsedMatches.slice(0, cap);

    return {
      ok: true,
      output: {
        matches,
        totalMatches,
        capped: totalMatches > cap,
        cap,
        searchPath: pathResolution.relativePath,
        pattern
      },
      artifacts: [],
      events: [
        {
          type: "skill.search_codebase.completed",
          level: "info",
          payload: {
            path: pathResolution.relativePath,
            totalMatches,
            returnedMatches: matches.length,
            capped: totalMatches > cap,
            extensions,
            durationMs
          }
        }
      ]
    };
  }
};
