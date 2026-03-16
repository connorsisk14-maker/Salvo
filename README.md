# Salvo v1 (Enforcement-First Harness)

Local-first agentic harness with a strict runtime contract, policy-enforced adapters, deterministic evaluation, and provenance-safe research synthesis.

## Components

- `apps/web`: Vite dashboard (Control Center, Tasks & Runs Board, Research Review, Integrations, Run Detail)
- `apps/orchestrator-api`: control-plane API (`create/read/approve/cancel` + read run/contract/event state)
- `apps/orchestrator-daemon`: task claim loop, contract generation, runner spawn, evaluation, retry
- `apps/agent-runner`: bounded runner that only uses policy-enforced adapters
- `apps/research-daemon`: analysis-only learning daemon (ingest, experiment, accepted-only publish)

## Packages

- `@salvo/shared`: enums, IDs, transitions, event names
- `@salvo/contracts`: contract schema and builder
- `@salvo/events`: event schema helpers
- `@salvo/tools`: filesystem and command adapters with policy checks
- `@salvo/evaluation`: deterministic weighted scoring + hard-fail gates
- `@salvo/db`: raw SQL-backed repository methods

## Environment

Copy `.env.example` to `.env` and set:

- `SALVO_DATABASE_URL`: Postgres connection string
- `SALVO_WORKSPACE_ROOT`: local path used for run workspaces and artifacts
- `SALVO_API_TOKEN`: bearer token required by the dashboard and protected API routes
- `SALVO_LOG_LEVEL`: structured log threshold (`debug`, `info`, `warn`, `error`)
- `SALVO_LOG_TARGET`: structured log output target (`stdout`, `stderr`, or `split`)
- `SALVO_BACKUP_DIR`: optional filesystem path for verified database backups
- `SALVO_BACKUP_HOUR_LOCAL`: daily backup hour in local server time (default `3`)
- `SALVO_BACKUP_RETENTION_DAILY`: number of daily archives to keep (default `7`)
- `SALVO_BACKUP_RETENTION_WEEKLY`: number of weekly archives to keep after daily retention (default `4`)
- `VITE_SALVO_API_URL`: API URL for dashboard (default `http://localhost:8787`)

## Migrations

Raw SQL migrations live in `supabase/migrations`.

- `0001_bootstrap.sql` bootstrap tables from initial setup
- `0002_runtime_contract.sql` runtime contract tables/indexes, append-only event guard, terminal run immutability
- `0003_daemon_heartbeats.sql` daemon heartbeat table for orchestrator/research health
- `0004_run_cancellation.sql` deferred cancellation marker (`cancellation_requested_at`) for active run cancellation
- `0005_integration_configs.sql` integration configuration storage
- `0006_llm_api_integration_cutover.sql` `claude_local -> llm_api` migration with compatibility merge
- `0007_research_analysis_pipeline.sql` research ingestion/experiment tables + contract-family memory scope

## Local Run

```bash
pnpm install
pnpm dev:api
pnpm dev:orchestrator
pnpm dev:research
pnpm dev:dashboard
# or run all services in parallel:
pnpm dev:all
```

Then open `http://localhost:5173`.

## UX Quick Start

Use the scripted flow to migrate DB + launch API/orchestrator/research/dashboard in the background:

```bash
pnpm ux:up
pnpm ux:status
```

To stop everything:

```bash
pnpm ux:down
```

## Checks

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
```

For DB-backed integration tests, set `SALVO_TEST_DATABASE_URL` (recommended) or `SALVO_DATABASE_URL`.
For e2e smoke test, keep API/orchestrator/research running and optionally set `SALVO_E2E_API_URL`.

## Daemon Health

Control-plane health endpoints:

- `GET /health`
- `GET /health/orchestrator`
- `GET /health/research`
- `POST /control/restart` with body `{ "target": "orchestrator" | "research" | "all" }`
- `GET /backups/status`, `POST /control/backup` for verified database backups
- `POST /runs/:id/retry` to re-queue failed/blocked/cancelled run tasks
- `POST /runs/:id/cancel` (active runs get `run.cancel_requested`; daemon force-cancels and finalizes)
- `POST /tasks/:id/reject` for `needs_review` tasks
- `GET /research`, `POST /research/:id/review`
- `GET /research/experiments`, `POST /research/experiments/:id/review`
- `GET /memories`, `POST /memories/:id/review`
- `GET /stream/overview`, `GET /stream/runs/:id` (SSE polling replacement for dashboard updates)

Daemon endpoints are DB-backed via `salvo_daemon_heartbeats` and return `healthy`, `stale`, or `offline`.

Backup automation writes compressed custom-format Postgres dumps, verifies them with `pg_restore --list`, and exposes status in the Control Center page. Recovery steps live in [docs/BACKUPS.md](/Users/connorsisk/Desktop/SALVO/docs/BACKUPS.md).

## Auditing Completed Work

- Open `Tasks & Runs Board` and use **Open proof** on a task/run.
- Run detail now includes a **Proof of Work** section with:
  - recorded artifacts (`salvo_artifacts`)
  - inline artifact preview (text/markdown) and image/screenshot rendering
  - final payload evidence (`run.final_payload`)
  - timeline events and linked synthesis docs

## Integrations + Cost View

- Open `/integrations` in the dashboard for:
  - live connector/integration status
  - estimated cost rollups by model and agent profile
  - token usage totals, updated in real time via SSE refresh
  - direct config updates for Supabase, LLM API, Process Adapter, and HTTP Adapter
