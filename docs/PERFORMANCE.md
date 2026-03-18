# Performance Baseline

`scripts/load-test.mjs` runs a concurrent control-plane load profile and emits a baseline summary for 3-5 simultaneous runs.

## Scope

- Submit `N` tasks to `/tasks` in parallel.
- Wait for each task to produce a run (`/runs`) and reach terminal state (`/runs/:id`).
- Capture per-run metrics: submit latency, queue-to-run latency, run-to-terminal latency, end-to-end latency.
- Emit summary stats (`min`, `avg`, `p50`, `p95`, `max`) and a copy/paste Markdown snippet.

## Run It

```bash
pnpm test:load
pnpm test:load:5
```

Optional environment variables:

- `SALVO_LOAD_API_URL` (default: `http://localhost:8787`)
- `SALVO_API_TOKEN` (optional bearer token)
- `SALVO_LOAD_CONCURRENCY` (clamped to `3..5`, default `3`)
- `SALVO_LOAD_TIMEOUT_MS` (default `180000`)
- `SALVO_LOAD_POLL_MS` (default `1000`)
- `SALVO_LOAD_REQUEST` (task request text)
- `SALVO_LOAD_REQUIRES_APPROVAL` (`true|false`, default `false`)
- `SALVO_LOAD_OUTPUT` (optional JSON report path)

CLI overrides are also supported:

```bash
node scripts/load-test.mjs --concurrency 4 --out tmp/load-baseline.json
```

## Baseline Template

Use the emitted markdown snippet or fill this template:

```md
## Baseline YYYY-MM-DD (N concurrent runs)

- API URL: <url>
- Completed/Submitted: <completed>/<submitted>
- Completed+Passed: <passed>/<submitted>
- End-to-end latency (ms): p50 <v>, p95 <v>, max <v>
- Queue-to-run latency (ms): p50 <v>, p95 <v>, max <v>
- Run-to-terminal latency (ms): p50 <v>, p95 <v>, max <v>
- Notes: <constraints, failures, environment context>
```

## Recommended Settings

Current `createDbPool` configuration does not set explicit pool limits, so `pg` defaults apply (notably `max=10`).
For repeatable 3-5 run load profiles, use the following targets:

- Simultaneous run profile: `3` for routine baseline checks, `5` for stress baseline.
- API + daemon processes: run one API process and one orchestrator daemon process during baseline collection to reduce confounding noise.
- DB pool target (recommended next config step): set explicit pool options in `packages/db/src/client.ts` such as:
  - `max: 16` (headroom above 5 in-flight runs plus API/research queries)
  - `idleTimeoutMillis: 30000`
  - `connectionTimeoutMillis: 5000`

If p95 queue-to-run latency grows disproportionately while end-to-end remains stable, investigate claim-loop throughput and DB contention first.
