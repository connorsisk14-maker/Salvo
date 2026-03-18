import { baseUrl, requestJson } from "./lib/api-client.mjs";

const rounds = Math.max(1, Number(process.env.SALVO_LOAD_ROUNDS ?? 3));
const pauseMs = Number(process.env.SALVO_LOAD_PAUSE_MS ?? 500);
const createTaskEvery = Math.max(0, Number(process.env.SALVO_LOAD_CREATE_TASK_EVERY ?? 2));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRound(round) {
  const [health, tasks, runs] = await Promise.all([
    requestJson("/health"),
    requestJson("/tasks"),
    requestJson("/runs")
  ]);

  console.log(
    `[load] round ${round}/${rounds}: health=${health.status ?? "unknown"} tasks=${tasks.length} runs=${runs.length}`
  );

  if (createTaskEvery > 0 && round % createTaskEvery === 0) {
    const title = `load-test-${round}-${new Date().toISOString()}`;
    await requestJson("/tasks", {
      method: "POST",
      body: JSON.stringify({
        title,
        request: "Document load test activity",
        requiresApproval: false
      })
    });
    console.log(`[load] created task ${title}`);
  }
}

async function main() {
  console.log(`[load] target ${baseUrl} with ${rounds} rounds`);
  for (let index = 1; index <= rounds; index += 1) {
    await runRound(index);
    if (index < rounds) {
      await sleep(pauseMs);
    }
  }
  console.log("[load] load test completed");
}

main().catch((error) => {
  console.error(`[load] FAIL: ${error.message}`);
  process.exit(1);
});
