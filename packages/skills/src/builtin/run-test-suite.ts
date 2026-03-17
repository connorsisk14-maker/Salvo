import type { Skill, SkillExecutionContext, SkillResult } from "../types";

export type RunTestSuiteInput = {
  command: string;
  args?: string[];
  pattern?: string;
  timeoutMs?: number;
};

export type RunTestSuiteCounts = {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
};

export type RunTestSuiteOutput = {
  command: string;
  args: string[];
  pattern?: string;
  exitCode: number | null;
  timedOut: boolean;
  denied: boolean;
  counts: RunTestSuiteCounts;
  output: string;
};

type CommandRunRequest = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
};

type CommandRunResult = {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  output?: string;
  timedOut?: boolean;
  timeout?: boolean;
  denied?: boolean;
};

type CommandAdapter = {
  runCommand?(request: CommandRunRequest): Promise<CommandRunResult> | CommandRunResult;
  run?(request: CommandRunRequest): Promise<CommandRunResult> | CommandRunResult;
  execute?(request: CommandRunRequest): Promise<CommandRunResult> | CommandRunResult;
};

function readNumberMatch(output: string, pattern: RegExp): number | undefined {
  const match = output.match(pattern);
  if (!match) {
    return undefined;
  }
  return Number(match[1]);
}

function parseNodeStyleCounts(output: string): Partial<RunTestSuiteCounts> {
  return {
    total: readNumberMatch(output, /^\s*[ℹi]?\s*tests?\s+(\d+)\s*$/im),
    passed: readNumberMatch(output, /^\s*[ℹi]?\s*pass(?:ed)?\s+(\d+)\s*$/im),
    failed: readNumberMatch(output, /^\s*[ℹi]?\s*fail(?:ed)?\s+(\d+)\s*$/im),
    skipped: readNumberMatch(output, /^\s*[ℹi]?\s*skip(?:ped)?\s+(\d+)\s*$/im)
  };
}

function parseSummaryTokens(line: string): Partial<RunTestSuiteCounts> {
  const counts: Partial<RunTestSuiteCounts> = {};
  const tokenPattern = /(\d+)\s+(failed|passed|total|skipped|pending|todo)\b/gi;
  for (const match of line.matchAll(tokenPattern)) {
    const value = Number(match[1]);
    const metric = match[2].toLowerCase();
    if (metric === "pending" || metric === "todo") {
      counts.skipped = (counts.skipped ?? 0) + value;
      continue;
    }
    if (metric === "failed") {
      counts.failed = (counts.failed ?? 0) + value;
      continue;
    }
    if (metric === "passed") {
      counts.passed = (counts.passed ?? 0) + value;
      continue;
    }
    if (metric === "total") {
      counts.total = (counts.total ?? 0) + value;
    }
  }

  if (counts.total === undefined) {
    const parenTotal = line.match(/\((\d+)\)/);
    if (parenTotal) {
      counts.total = Number(parenTotal[1]);
    }
  }

  return counts;
}

function parseSummaryStyleCounts(output: string): Partial<RunTestSuiteCounts> {
  const lines = output.split(/\r?\n/);
  const totals: Partial<RunTestSuiteCounts> = {};

  for (const line of lines) {
    if (!/^\s*Tests?(?:\s*:|\s{2,})/i.test(line)) {
      continue;
    }
    const parsed = parseSummaryTokens(line);
    if (parsed.passed !== undefined) {
      totals.passed = Math.max(totals.passed ?? 0, parsed.passed);
    }
    if (parsed.failed !== undefined) {
      totals.failed = Math.max(totals.failed ?? 0, parsed.failed);
    }
    if (parsed.skipped !== undefined) {
      totals.skipped = Math.max(totals.skipped ?? 0, parsed.skipped);
    }
    if (parsed.total !== undefined) {
      totals.total = Math.max(totals.total ?? 0, parsed.total);
    }
  }

  return totals;
}

function parseFallbackCounts(output: string): Partial<RunTestSuiteCounts> {
  const totals: Partial<RunTestSuiteCounts> = {};
  const pattern = /(\d+)\s+(failed|passed|total|skipped)\b/gi;
  for (const match of output.matchAll(pattern)) {
    const value = Number(match[1]);
    const metric = match[2].toLowerCase() as "failed" | "passed" | "total" | "skipped";
    totals[metric] = Math.max(totals[metric] ?? 0, value);
  }
  return totals;
}

function normalizeCounts(counts: Partial<RunTestSuiteCounts>): RunTestSuiteCounts {
  const passed = counts.passed ?? 0;
  const failed = counts.failed ?? 0;
  const skipped = counts.skipped ?? 0;
  const total = counts.total ?? passed + failed + skipped;
  return {
    passed,
    failed,
    skipped,
    total
  };
}

export function parseTestSuiteCounts(output: string): RunTestSuiteCounts {
  const nodeStyle = parseNodeStyleCounts(output);
  if (
    nodeStyle.total !== undefined ||
    nodeStyle.passed !== undefined ||
    nodeStyle.failed !== undefined ||
    nodeStyle.skipped !== undefined
  ) {
    return normalizeCounts(nodeStyle);
  }

  const summaryStyle = parseSummaryStyleCounts(output);
  if (
    summaryStyle.total !== undefined ||
    summaryStyle.passed !== undefined ||
    summaryStyle.failed !== undefined ||
    summaryStyle.skipped !== undefined
  ) {
    return normalizeCounts(summaryStyle);
  }

  return normalizeCounts(parseFallbackCounts(output));
}

function resolveCommandAdapter(context: SkillExecutionContext): CommandAdapter | null {
  const adapters = context.adapters as Record<string, unknown>;
  const candidate = adapters.command ?? adapters.commandRunner ?? adapters.exec;
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const adapter = candidate as CommandAdapter;
  if (
    typeof adapter.runCommand !== "function" &&
    typeof adapter.run !== "function" &&
    typeof adapter.execute !== "function"
  ) {
    return null;
  }
  return adapter;
}

async function runWithAdapter(
  adapter: CommandAdapter,
  request: CommandRunRequest
): Promise<CommandRunResult> {
  if (typeof adapter.runCommand === "function") {
    return adapter.runCommand(request);
  }
  if (typeof adapter.run === "function") {
    return adapter.run(request);
  }
  if (typeof adapter.execute === "function") {
    return adapter.execute(request);
  }
  throw new Error("No supported command execution method was found on adapter.");
}

function composeOutput(result: CommandRunResult): string {
  if (typeof result.output === "string" && result.output.length > 0) {
    return result.output;
  }
  const chunks = [result.stdout ?? "", result.stderr ?? ""].filter(Boolean);
  return chunks.join("\n").trim();
}

export const runTestSuiteSkill: Skill<RunTestSuiteInput, RunTestSuiteOutput> = {
  name: "run_test_suite",
  version: "1.0.0",
  description: "Run a test command through a command adapter and parse test totals.",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", minLength: 1 },
      args: {
        type: "array",
        items: { type: "string" },
        default: []
      },
      pattern: { type: "string" },
      timeoutMs: { type: "number", minimum: 1 }
    }
  },
  async execute(
    input: RunTestSuiteInput,
    context: SkillExecutionContext
  ): Promise<SkillResult<RunTestSuiteOutput>> {
    const adapter = resolveCommandAdapter(context);
    const baseArgs = [...(input.args ?? [])];
    const pattern = input.pattern?.trim();
    if (pattern && !baseArgs.includes(pattern)) {
      baseArgs.push(pattern);
    }

    if (!adapter) {
      return {
        ok: false,
        output: {
          command: input.command,
          args: baseArgs,
          pattern: pattern || undefined,
          exitCode: null,
          timedOut: false,
          denied: true,
          counts: {
            passed: 0,
            failed: 0,
            skipped: 0,
            total: 0
          },
          output: "Command adapter is not configured in skill context."
        },
        artifacts: [],
        events: [
          {
            type: "test_suite.run_denied",
            level: "error",
            payload: {
              reason: "missing_command_adapter"
            }
          }
        ]
      };
    }

    const result = await runWithAdapter(adapter, {
      command: input.command,
      args: baseArgs,
      cwd: context.workspacePath,
      timeoutMs: input.timeoutMs
    });
    const output = composeOutput(result);
    const counts = parseTestSuiteCounts(output);
    const timedOut = Boolean(result.timedOut ?? result.timeout);
    const denied = Boolean(result.denied);
    const exitCode = result.exitCode ?? null;
    const ok = !timedOut && !denied && exitCode === 0 && counts.failed === 0;

    return {
      ok,
      output: {
        command: input.command,
        args: baseArgs,
        pattern: pattern || undefined,
        exitCode,
        timedOut,
        denied,
        counts,
        output
      },
      artifacts: [],
      events: [
        {
          type: "test_suite.run_completed",
          level: ok ? "info" : "warn",
          payload: {
            command: input.command,
            exit_code: exitCode,
            timed_out: timedOut,
            denied,
            passed: counts.passed,
            failed: counts.failed,
            skipped: counts.skipped,
            total: counts.total
          }
        }
      ]
    };
  }
};
