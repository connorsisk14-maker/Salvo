import { spawn } from "node:child_process";
import type { Adapter, AdapterRunRequest, AdapterRunResult } from "./types";

export class ProcessAdapter implements Adapter {
  readonly key = "process";

  constructor(private readonly command = "") {}

  async health() {
    if (!this.command) {
      return {
        status: "not_configured" as const,
        detail: "Set a command for ProcessAdapter to execute workloads."
      };
    }

    return {
      status: "ready" as const,
      detail: `Process adapter configured with command: ${this.command}`
    };
  }

  async run(request: AdapterRunRequest): Promise<AdapterRunResult> {
    const health = await this.health();
    if (health.status !== "ready") {
      return {
        ok: false,
        detail: health.detail ?? "Process adapter is blocked."
      };
    }

    return new Promise((resolve) => {
      const child = spawn(this.command, [JSON.stringify(request.payload)], {
        shell: true
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve({
            ok: true,
            detail: `Process adapter run ${request.runId} completed.`,
            output: stdout.trim()
          });
          return;
        }

        resolve({
          ok: false,
          detail: stderr.trim() || `Process exited with code ${code ?? -1}.`
        });
      });
    });
  }
}
