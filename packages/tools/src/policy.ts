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

function normalizePathSet(paths: string[]): string[] {
  const normalized = [...new Set(paths.map((entry) => path.resolve(entry)))].sort();
  return normalized.filter((candidate, index) => {
    return !normalized.some((other, otherIndex) => {
      if (index === otherIndex) {
        return false;
      }
      return candidate !== other && isWithinPath(candidate, other);
    });
  });
}

function intersectPathAllowlists(basePaths: string[], overlayPaths: string[]): string[] {
  if (overlayPaths.length === 0) {
    return normalizePathSet(basePaths);
  }
  if (basePaths.length === 0) {
    return normalizePathSet(overlayPaths);
  }

  const intersections: string[] = [];
  for (const basePath of basePaths) {
    for (const overlayPath of overlayPaths) {
      if (isWithinPath(basePath, overlayPath)) {
        intersections.push(path.resolve(overlayPath));
      } else if (isWithinPath(overlayPath, basePath)) {
        intersections.push(path.resolve(basePath));
      }
    }
  }

  return normalizePathSet(intersections);
}

function intersectExactAllowlists(baseValues: string[], overlayValues: string[]): string[] {
  if (overlayValues.length === 0) {
    return [...new Set(baseValues)].sort();
  }
  if (baseValues.length === 0) {
    return [...new Set(overlayValues)].sort();
  }

  return [...new Set(baseValues.filter((entry) => overlayValues.includes(entry)))].sort();
}

function uniqueCombined(valuesA: string[], valuesB: string[]): string[] {
  return [...new Set([...valuesA, ...valuesB])].sort();
}

function resolvePolicyEntries(rootDir: string | undefined, entries: string[]): string[] {
  return entries.map((entry) => (rootDir ? path.resolve(rootDir, entry) : path.resolve(entry)));
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

export type ToolPolicyOverlay = Partial<ToolPolicy> & {
  commandTimeoutMs?: number;
};

export function mergeToolPolicies(
  base: ToolPolicy,
  overlay?: ToolPolicyOverlay,
  rootDir?: string
): ToolPolicy {
  if (!overlay) {
    return {
      ...base,
      allowedReadPaths: [...base.allowedReadPaths],
      allowedWritePaths: [...base.allowedWritePaths],
      forbiddenPaths: [...base.forbiddenPaths],
      allowedCommands: [...base.allowedCommands],
      allowedCommandCwds: [...base.allowedCommandCwds]
    };
  }

  const overlayReadPaths = resolvePolicyEntries(rootDir, overlay.allowedReadPaths ?? []);
  const overlayWritePaths = resolvePolicyEntries(rootDir, overlay.allowedWritePaths ?? []);
  const overlayForbiddenPaths = resolvePolicyEntries(rootDir, overlay.forbiddenPaths ?? []);
  const overlayCommandCwds = resolvePolicyEntries(rootDir, overlay.allowedCommandCwds ?? []);

  const mergedAllowedReadPaths = intersectPathAllowlists(
    base.allowedReadPaths,
    overlayReadPaths
  );
  const mergedAllowedWritePaths = intersectPathAllowlists(
    base.allowedWritePaths,
    overlayWritePaths
  );
  const mergedForbiddenPaths = uniqueCombined(
    base.forbiddenPaths,
    overlayForbiddenPaths
  );
  const mergedAllowedCommands = intersectExactAllowlists(
    base.allowedCommands,
    overlay.allowedCommands ?? []
  );
  const mergedAllowedCommandCwds = intersectPathAllowlists(
    base.allowedCommandCwds,
    overlayCommandCwds
  );

  return {
    allowedReadPaths: mergedAllowedReadPaths,
    allowedWritePaths: mergedAllowedWritePaths,
    forbiddenPaths: mergedForbiddenPaths,
    allowedCommands: mergedAllowedCommands,
    allowedCommandCwds: mergedAllowedCommandCwds,
    commandTimeoutMs:
      typeof overlay.commandTimeoutMs === "number" && overlay.commandTimeoutMs > 0
        ? Math.min(base.commandTimeoutMs, overlay.commandTimeoutMs)
        : base.commandTimeoutMs
  };
}
