import { spawn } from "node:child_process";
import { evaluateCommandPolicy } from "./policy";
import type { CommandExecutionResult, ToolPolicy } from "./types";

export class CommandAdapter {
  constructor(private readonly policy: ToolPolicy) {}

  async run(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs = this.policy.commandTimeoutMs
  ): Promise<CommandExecutionResult> {
    const decision = evaluateCommandPolicy(command, args, cwd, this.policy);
    if (!decision.allowed) {
      return { ok: false, decision };
    }

    const startedAt = Date.now();

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startedAt;

        if (timedOut) {
          resolve({
            ok: false,
            decision: {
              allowed: false,
              reason: "timeout",
              message: `Command exceeded timeout (${timeoutMs}ms).`
            },
            durationMs,
            stdout,
            stderr
          });
          return;
        }

        resolve({
          ok: true,
          exitCode: code ?? -1,
          stdout,
          stderr,
          durationMs
        });
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          decision: {
            allowed: false,
            reason: "command_not_allowlisted",
            message: `Command failed to start: ${error.message}`
          }
        });
      });
    });
  }

  async runCommand(request: {
    command: string;
    args: string[];
    cwd: string;
    timeoutMs?: number;
  }): Promise<CommandExecutionResult> {
    return this.run(request.command, request.args, request.cwd, request.timeoutMs);
  }

  async execute(request: {
    command: string;
    args: string[];
    cwd: string;
    timeoutMs?: number;
  }): Promise<CommandExecutionResult> {
    return this.runCommand(request);
  }
}
