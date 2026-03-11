import path from "node:path";
import type { PolicyDecision, ToolPolicy } from "./types";

function ensureTrailingSeparator(input: string): string {
  return input.endsWith(path.sep) ? input : `${input}${path.sep}`;
}

function isWithinPath(basePath: string, candidatePath: string): boolean {
  const normalizedBase = ensureTrailingSeparator(path.resolve(basePath));
  const normalizedCandidate = path.resolve(candidatePath);
  return (
    normalizedCandidate === path.resolve(basePath) ||
    normalizedCandidate.startsWith(normalizedBase)
  );
}

export function resolvePolicyPaths(rootDir: string, paths: string[]): string[] {
  return paths.map((entry) =>
    path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(rootDir, entry)
  );
}

export function evaluateReadPathPolicy(
  absolutePath: string,
  policy: ToolPolicy
): PolicyDecision {
  if (policy.forbiddenPaths.some((forbidden) => isWithinPath(forbidden, absolutePath))) {
    return {
      allowed: false,
      reason: "forbidden_path",
      message: `Path ${absolutePath} is forbidden by policy.`
    };
  }

  if (!policy.allowedReadPaths.some((allowed) => isWithinPath(allowed, absolutePath))) {
    return {
      allowed: false,
      reason: "path_not_allowlisted",
      message: `Path ${absolutePath} is not in read allowlist.`
    };
  }

  return { allowed: true };
}

export function evaluateWritePathPolicy(
  absolutePath: string,
  policy: ToolPolicy
): PolicyDecision {
  if (policy.forbiddenPaths.some((forbidden) => isWithinPath(forbidden, absolutePath))) {
    return {
      allowed: false,
      reason: "forbidden_path",
      message: `Path ${absolutePath} is forbidden by policy.`
    };
  }

  if (!policy.allowedWritePaths.some((allowed) => isWithinPath(allowed, absolutePath))) {
    return {
      allowed: false,
      reason: "path_not_allowlisted",
      message: `Path ${absolutePath} is not in write allowlist.`
    };
  }

  return { allowed: true };
}

export function evaluateCommandPolicy(
  command: string,
  args: string[],
  cwd: string,
  policy: ToolPolicy
): PolicyDecision {
  if (!policy.allowedCommands.includes(command)) {
    return {
      allowed: false,
      reason: "command_not_allowlisted",
      message: `Command ${command} is not allowlisted.`
    };
  }

  if (!policy.allowedCommandCwds.some((allowedCwd) => isWithinPath(allowedCwd, cwd))) {
    return {
      allowed: false,
      reason: "cwd_not_allowlisted",
      message: `Command cwd ${cwd} is outside allowlisted directories.`
    };
  }

  const invalidArg = args.find((arg) => /[;&|`$<>]/.test(arg));
  if (invalidArg) {
    return {
      allowed: false,
      reason: "invalid_argument",
      message: `Command argument contains restricted characters: ${invalidArg}`
    };
  }

  return { allowed: true };
}

export function buildToolPolicy(rootDir: string, overrides?: Partial<ToolPolicy>): ToolPolicy {
  const base: ToolPolicy = {
    allowedReadPaths: [rootDir],
    allowedWritePaths: [rootDir],
    forbiddenPaths: [path.resolve(rootDir, ".git"), path.resolve(rootDir, "node_modules")],
    allowedCommands: ["ls", "cat", "echo", "pnpm", "npm", "node"],
    allowedCommandCwds: [rootDir],
    commandTimeoutMs: 20_000
  };

  const merged: ToolPolicy = {
    ...base,
    ...overrides,
    allowedReadPaths: overrides?.allowedReadPaths ?? base.allowedReadPaths,
    allowedWritePaths: overrides?.allowedWritePaths ?? base.allowedWritePaths,
    forbiddenPaths: overrides?.forbiddenPaths ?? base.forbiddenPaths,
    allowedCommands: overrides?.allowedCommands ?? base.allowedCommands,
    allowedCommandCwds: overrides?.allowedCommandCwds ?? base.allowedCommandCwds
  };

  return {
    ...merged,
    allowedReadPaths: resolvePolicyPaths(rootDir, merged.allowedReadPaths),
    allowedWritePaths: resolvePolicyPaths(rootDir, merged.allowedWritePaths),
    forbiddenPaths: resolvePolicyPaths(rootDir, merged.forbiddenPaths),
    allowedCommandCwds: resolvePolicyPaths(rootDir, merged.allowedCommandCwds)
  };
}
