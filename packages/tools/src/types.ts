import type { PolicyDenyReason } from "@salvo/shared";

export type ToolPolicy = {
  allowedReadPaths: string[];
  allowedWritePaths: string[];
  forbiddenPaths: string[];
  allowedCommands: string[];
  allowedCommandCwds: string[];
  commandTimeoutMs: number;
};

export type PolicyDecision =
  | {
      allowed: true;
    }
  | {
      allowed: false;
      reason: PolicyDenyReason;
      message: string;
    };

export type FileReadResult =
  | {
      ok: true;
      content: string;
      absolutePath: string;
    }
  | {
      ok: false;
      decision: Exclude<PolicyDecision, { allowed: true }>;
    };

export type FileWriteResult =
  | {
      ok: true;
      absolutePath: string;
    }
  | {
      ok: false;
      decision: Exclude<PolicyDecision, { allowed: true }>;
    };

export type CommandExecutionResult =
  | {
      ok: true;
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
    }
  | {
      ok: false;
      decision: Exclude<PolicyDecision, { allowed: true }>;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      durationMs?: number;
    };
