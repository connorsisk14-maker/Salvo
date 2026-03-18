import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildRuntimeEnv } from "./prod-preflight.mjs";

const serviceLabels = [
  "com.salvo.orchestrator-api",
  "com.salvo.orchestrator-daemon",
  "com.salvo.research-daemon"
];

function launchctl(args, options = {}) {
  const result = spawnSync("launchctl", args, {
    encoding: "utf8"
  });
  if (result.status !== 0 && !options.allowFailure) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    throw new Error(
      `launchctl ${args.join(" ")} failed: ${stderr || stdout || `exit ${result.status}`}`
    );
  }
  return result;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const keepPlists = args.has("--keep-plists");

  await buildRuntimeEnv();
  const uid = process.getuid?.();
  if (typeof uid !== "number") {
    throw new Error("Unable to resolve current user id for launchctl GUI domain.");
  }
  const domain = `gui/${uid}`;
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");

  for (const label of serviceLabels) {
    launchctl(["bootout", `${domain}/${label}`], { allowFailure: true });
    launchctl(["remove", label], { allowFailure: true });
    if (!keepPlists) {
      const plistPath = path.join(launchAgentsDir, `${label}.plist`);
      await rm(plistPath, { force: true });
    }
    console.log(`[prod-down] stopped ${label}`);
  }

  if (keepPlists) {
    console.log("[prod-down] retained launchd plists (--keep-plists)");
  } else {
    console.log("[prod-down] removed launchd plists from ~/Library/LaunchAgents");
  }
  console.log("[prod-down] production services are down");
}

void main().catch((error) => {
  console.error(`[prod-down] FAIL: ${error.message}`);
  process.exit(1);
});
