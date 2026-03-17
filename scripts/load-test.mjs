#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const terminalRunStates = new Set(["completed", "failed", "blocked", "cancelled"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--") {
      continue;
    }
    if (!current.startsWith("--")) {
      continue;
    }
    const key = current.slice(2);
    if (!key) {
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function toIsoStringOrNull(value) {
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function toEpochMsOrNull(value) {
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.getTime();
}

function summarize(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const average = Math.round((sum / sorted.length) * 100) / 100;
  const percentile = (p) => {
    const rank = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[rank];
  };

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: average,
    p50: percentile(50),
    p95: percentile(95)
  };
}

function normalizeConcurrency(requested) {
  const value = parseInteger(requested, 3);
  if (value < 3) {
    return 3;
  }
  if (value > 5) {
    return 5;
  }
  return value;
}

function formatMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${Math.round(value)}ms`;
}

function buildHeaders(token) {
  const headers = {
    "content-type": "application/json"
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function requestJson(baseUrl, token, endpoint, init) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...init,
    headers: {
      ...buildHeaders(token),
      ...(init?.headers ?? {})
    }
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `Request failed ${response.status} ${endpoint}${raw ? ` :: ${raw.slice(0, 240)}` : ""}`
    );
  }

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Expected JSON response from ${endpoint}.`);
  }
}

async function waitForRun(baseUrl, token, taskId, timeoutMs, pollMs, startedAt) {
  let polls = 0;
  while (Date.now() - startedAt < timeoutMs) {
    polls += 1;
    const runs = await requestJson(baseUrl, token, "/runs");
    const run = Array.isArray(runs) ? runs.find((entry) => entry.task_id === taskId) : null;
    if (run) {
      return {
        run,
        detectedAtMs: Date.now(),
        polls
      };
    }
    await sleep(pollMs);
  }

  throw new Error(`Timed out waiting for run creation for task ${taskId}.`);
}

async function waitForTerminalRun(baseUrl, token, runId, timeoutMs, pollMs, startedAt) {
  let polls = 0;
  while (Date.now() - startedAt < timeoutMs) {
    polls += 1;
    const detail = await requestJson(baseUrl, token, `/runs/${runId}`);
    if (detail?.run?.status && terminalRunStates.has(detail.run.status)) {
      return {
        detail,
        detectedAtMs: Date.now(),
        polls
      };
    }
    await sleep(pollMs);
  }

  throw new Error(`Timed out waiting for terminal run status for run ${runId}.`);
}

async function executeSingleRun({
  index,
  baseUrl,
  token,
  timeoutMs,
  pollMs,
  requestText,
  requiresApproval,
  startedAt
}) {
  const submitStartedAtMs = Date.now();
  const task = await requestJson(baseUrl, token, "/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: `load-test-${index}-${new Date().toISOString()}`,
      request: requestText,
      requiresApproval
    })
  });
  const submittedAtMs = Date.now();

  const runResult = await waitForRun(baseUrl, token, task.id, timeoutMs, pollMs, startedAt);
  const terminalResult = await waitForTerminalRun(
    baseUrl,
    token,
    runResult.run.id,
    timeoutMs,
    pollMs,
    startedAt
  );

  let eventCount = null;
  try {
    const events = await requestJson(baseUrl, token, `/runs/${runResult.run.id}/events`);
    if (Array.isArray(events)) {
      eventCount = events.length;
    }
  } catch {
    eventCount = null;
  }

  const taskCreatedAtMs = toEpochMsOrNull(task.created_at) ?? submittedAtMs;
  const runCreatedAtMs = toEpochMsOrNull(runResult.run.created_at) ?? runResult.detectedAtMs;
  const terminalDetectedAtMs = terminalResult.detectedAtMs;

  return {
    taskId: task.id,
    taskCreatedAt: toIsoStringOrNull(task.created_at),
    runId: runResult.run.id,
    runCreatedAt: toIsoStringOrNull(runResult.run.created_at),
    status: terminalResult.detail.run.status,
    evaluationPassed: terminalResult.detail.evaluation?.passed === true,
    artifacts: Array.isArray(terminalResult.detail.artifacts)
      ? terminalResult.detail.artifacts.length
      : 0,
    eventCount,
    submitLatencyMs: submittedAtMs - submitStartedAtMs,
    queueToRunMs: Math.max(0, runCreatedAtMs - taskCreatedAtMs),
    runToTerminalMs: Math.max(0, terminalDetectedAtMs - runCreatedAtMs),
    endToEndMs: Math.max(0, terminalDetectedAtMs - submitStartedAtMs),
    runPolls: runResult.polls,
    terminalPolls: terminalResult.polls
  };
}

async function maybeWriteJson(outputPath, payload) {
  if (!outputPath) {
    return;
  }

  const absolutePath = path.resolve(process.cwd(), outputPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`[load] wrote report to ${absolutePath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const baseUrl =
    args.url ??
    process.env.SALVO_LOAD_API_URL ??
    process.env.SALVO_E2E_API_URL ??
    "http://localhost:8787";
  const token = args.token ?? process.env.SALVO_API_TOKEN ?? process.env.SALVO_E2E_API_TOKEN ?? "";
  const timeoutMs = parseInteger(args.timeoutMs ?? process.env.SALVO_LOAD_TIMEOUT_MS, 180_000);
  const pollMs = parseInteger(args.pollMs ?? process.env.SALVO_LOAD_POLL_MS, 1_000);
  const concurrency = normalizeConcurrency(args.concurrency ?? process.env.SALVO_LOAD_CONCURRENCY);
  const requiresApproval = parseBoolean(
    args.requiresApproval ?? process.env.SALVO_LOAD_REQUIRES_APPROVAL,
    false
  );
  const requestText =
    args.request ??
    process.env.SALVO_LOAD_REQUEST ??
    "Create a sample run summary artifact for load/performance baseline.";
  const outputPath = args.out ?? process.env.SALVO_LOAD_OUTPUT ?? "";

  const startedAt = Date.now();

  console.log(`[load] baseUrl: ${baseUrl}`);
  console.log(`[load] concurrency: ${concurrency} (supported range: 3-5)`);
  console.log(`[load] timeoutMs: ${timeoutMs} | pollMs: ${pollMs}`);
  console.log(`[load] requiresApproval: ${requiresApproval}`);
  console.log(`[load] submitting ${concurrency} tasks concurrently...`);

  const executions = await Promise.allSettled(
    Array.from({ length: concurrency }, (_, index) =>
      executeSingleRun({
        index: index + 1,
        baseUrl,
        token,
        timeoutMs,
        pollMs,
        requestText,
        requiresApproval,
        startedAt
      })
    )
  );

  const finishedAt = Date.now();

  const runs = [];
  const errors = [];
  for (const execution of executions) {
    if (execution.status === "fulfilled") {
      runs.push(execution.value);
      continue;
    }
    errors.push(execution.reason instanceof Error ? execution.reason.message : String(execution.reason));
  }

  const submitLatencies = runs.map((entry) => entry.submitLatencyMs);
  const queueToRunLatencies = runs.map((entry) => entry.queueToRunMs);
  const runToTerminalLatencies = runs.map((entry) => entry.runToTerminalMs);
  const endToEndLatencies = runs.map((entry) => entry.endToEndMs);
  const succeeded = runs.filter((entry) => entry.status === "completed" && entry.evaluationPassed).length;

  const report = {
    generatedAt: new Date().toISOString(),
    profile: {
      baseUrl,
      concurrency,
      timeoutMs,
      pollMs,
      requiresApproval
    },
    totals: {
      submitted: concurrency,
      completed: runs.length,
      failedRequests: errors.length,
      completedAndPassed: succeeded,
      terminalByStatus: runs.reduce((accumulator, run) => {
        accumulator[run.status] = (accumulator[run.status] ?? 0) + 1;
        return accumulator;
      }, {})
    },
    latencyMs: {
      submit: summarize(submitLatencies),
      queueToRun: summarize(queueToRunLatencies),
      runToTerminal: summarize(runToTerminalLatencies),
      endToEnd: summarize(endToEndLatencies)
    },
    runs,
    errors,
    wallClockMs: finishedAt - startedAt
  };

  await maybeWriteJson(outputPath, report);

  console.log("");
  console.log("[load] Run Summary");
  console.log(
    `[load] completed ${report.totals.completed}/${report.totals.submitted} | passed ${report.totals.completedAndPassed}/${report.totals.submitted}`
  );
  console.log(`[load] wall clock: ${formatMs(report.wallClockMs)}`);

  if (report.latencyMs.endToEnd) {
    console.log(
      `[load] end-to-end p50 ${formatMs(report.latencyMs.endToEnd.p50)} | p95 ${formatMs(report.latencyMs.endToEnd.p95)}`
    );
  }
  if (report.latencyMs.queueToRun) {
    console.log(
      `[load] queue-to-run p50 ${formatMs(report.latencyMs.queueToRun.p50)} | p95 ${formatMs(report.latencyMs.queueToRun.p95)}`
    );
  }
  if (report.latencyMs.runToTerminal) {
    console.log(
      `[load] run-to-terminal p50 ${formatMs(report.latencyMs.runToTerminal.p50)} | p95 ${formatMs(report.latencyMs.runToTerminal.p95)}`
    );
  }

  console.log("");
  console.log("[load] Per-Run");
  for (const run of runs) {
    console.log(
      `[load] task=${run.taskId} run=${run.runId} status=${run.status} passed=${run.evaluationPassed} e2e=${formatMs(run.endToEndMs)} queue=${formatMs(run.queueToRunMs)}`
    );
  }

  if (errors.length > 0) {
    console.log("");
    console.log("[load] Errors");
    for (const error of errors) {
      console.log(`[load] ${error}`);
    }
  }

  console.log("");
  console.log("[load] Markdown Baseline Snippet");
  console.log("```md");
  console.log(`## Baseline ${new Date(report.generatedAt).toISOString().slice(0, 10)} (${concurrency} concurrent runs)`);
  console.log("");
  console.log(`- API URL: ${baseUrl}`);
  console.log(`- Completed/Submitted: ${report.totals.completed}/${report.totals.submitted}`);
  console.log(`- Completed+Passed: ${report.totals.completedAndPassed}/${report.totals.submitted}`);
  if (report.latencyMs.endToEnd) {
    console.log(
      `- End-to-end latency (ms): p50 ${report.latencyMs.endToEnd.p50}, p95 ${report.latencyMs.endToEnd.p95}, max ${report.latencyMs.endToEnd.max}`
    );
  }
  if (report.latencyMs.queueToRun) {
    console.log(
      `- Queue-to-run latency (ms): p50 ${report.latencyMs.queueToRun.p50}, p95 ${report.latencyMs.queueToRun.p95}, max ${report.latencyMs.queueToRun.max}`
    );
  }
  if (report.latencyMs.runToTerminal) {
    console.log(
      `- Run-to-terminal latency (ms): p50 ${report.latencyMs.runToTerminal.p50}, p95 ${report.latencyMs.runToTerminal.p95}, max ${report.latencyMs.runToTerminal.max}`
    );
  }
  console.log("```");

  if (report.totals.completed !== report.totals.submitted || report.totals.completedAndPassed !== report.totals.submitted) {
    process.exitCode = 1;
    return;
  }

  console.log("[load] PASS");
}

main().catch((error) => {
  console.error(`[load] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
