const baseUrl = process.env.SALVO_E2E_API_URL ?? "http://localhost:8787";
const timeoutMs = Number(process.env.SALVO_E2E_TIMEOUT_MS ?? 45_000);
const requireResearch =
  (process.env.SALVO_E2E_REQUIRE_RESEARCH ?? "0").toLowerCase() === "1";
const apiToken = process.env.SALVO_E2E_API_TOKEN ?? process.env.SALVO_API_TOKEN ?? "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
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

async function waitForRunEvents(runId, startedAt) {
  while (Date.now() - startedAt < timeoutMs) {
    const events = await request(`/runs/${runId}/events`);
    if (Array.isArray(events) && events.length > 0) {
      return events;
    }
    await sleep(1000);
  }

  throw new Error(`Timed out waiting for run events for run ${runId}`);
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
  if (!terminal.final_payload) {
    throw new Error("Final payload missing from run detail.");
  }
  if (!Array.isArray(terminal.final_payload.evidence?.tests_run)) {
    throw new Error("Final payload tests_run missing.");
  }
  if (!terminal.final_payload.evidence.tests_run.some((entry) => entry.command === "echo salvo-test")) {
    throw new Error("Expected final payload to include echo salvo-test evidence.");
  }

  if (!Array.isArray(terminal.artifacts) || terminal.artifacts.length === 0) {
    throw new Error("Expected at least one artifact in run detail.");
  }

  const events = await waitForRunEvents(run.id, startedAt);
  if (!events.some((event) => event.event_type === "tool.called")) {
    throw new Error("Expected at least one tool.called event.");
  }
  if (!events.some((event) => event.event_type === "tool.result" || event.event_type === "policy.denied")) {
    throw new Error("Expected at least one tool.result or policy.denied event.");
  }
  if (events.some((event) => event.event_type === "policy.denied")) {
    throw new Error("Smoke run should not emit policy.denied.");
  }

  console.log(`[e2e] final payload status: ${terminal.final_payload.status}`);
  console.log(`[e2e] artifacts: ${terminal.artifacts.length}`);
  console.log(`[e2e] events: ${events.length}`);
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
