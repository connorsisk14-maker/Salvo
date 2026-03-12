const baseUrl = process.env.SALVO_E2E_API_URL ?? "http://localhost:8787";
const timeoutMs = Number(process.env.SALVO_E2E_TIMEOUT_MS ?? 45_000);
const requireResearch =
  (process.env.SALVO_E2E_REQUIRE_RESEARCH ?? "0").toLowerCase() === "1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${path}`);
  }

  return response.json();
}

async function waitForRun(taskId, startedAt) {
  while (Date.now() - startedAt < timeoutMs) {
    const runs = await request("/runs");
    const run = runs.find((item) => item.task_id === taskId);
    if (run) {
      return run;
    }
    await sleep(750);
  }

  throw new Error(`Timed out waiting for run creation for task ${taskId}`);
}

async function waitForTerminalRun(runId, startedAt) {
  const terminal = new Set(["completed", "failed", "blocked", "cancelled"]);

  while (Date.now() - startedAt < timeoutMs) {
    const detail = await request(`/runs/${runId}`);
    if (terminal.has(detail.run.status)) {
      return detail;
    }
    await sleep(1000);
  }

  throw new Error(`Timed out waiting for terminal status for run ${runId}`);
}

async function waitForResearch(runId, startedAt) {
  while (Date.now() - startedAt < timeoutMs) {
    const detail = await request(`/runs/${runId}`);
    if (Array.isArray(detail.research) && detail.research.length > 0) {
      return detail;
    }
    await sleep(1000);
  }

  throw new Error(`Timed out waiting for research synthesis for run ${runId}`);
}

async function main() {
  const startedAt = Date.now();
  const title = `e2e-smoke-${new Date().toISOString()}`;

  console.log(`[e2e] submitting task to ${baseUrl}`);
  const task = await request("/tasks", {
    method: "POST",
    body: JSON.stringify({
      title,
      request: "Create a sample run summary artifact for smoke test.",
      requiresApproval: false
    })
  });

  console.log(`[e2e] task created: ${task.id}`);

  const run = await waitForRun(task.id, startedAt);
  console.log(`[e2e] run created: ${run.id}`);

  const terminal = await waitForTerminalRun(run.id, startedAt);
  console.log(`[e2e] run terminal status: ${terminal.run.status}`);

  if (terminal.run.status !== "completed") {
    throw new Error(`Expected completed run, got ${terminal.run.status}`);
  }

  if (!terminal.evaluation || terminal.evaluation.passed !== true) {
    throw new Error("Evaluation missing or not passed.");
  }

  console.log(`[e2e] evaluation score: ${terminal.evaluation.score}`);
  if (requireResearch) {
    const detail = await waitForResearch(run.id, startedAt);
    console.log(`[e2e] research docs: ${detail.research.length}`);
  } else {
    const detail = await request(`/runs/${run.id}`);
    console.log(
      `[e2e] research docs currently linked: ${Array.isArray(detail.research) ? detail.research.length : 0}`
    );
  }
  console.log("[e2e] PASS");
}

main().catch((error) => {
  console.error(`[e2e] FAIL: ${error.message}`);
  process.exit(1);
});
