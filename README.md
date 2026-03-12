# Salvo v1 (Enforcement-First Harness)

Local-first agentic harness with a strict runtime contract, policy-enforced adapters, deterministic evaluation, and provenance-safe research synthesis.

## Components

- `apps/web`: Vite dashboard (Control Center, Tasks & Runs Board, Research Review, Run Detail)
- `apps/orchestrator-api`: control-plane API (`create/read/approve/cancel` + read run/contract/event state)
- `apps/orchestrator-daemon`: task claim loop, contract generation, runner spawn, evaluation, retry
- `apps/agent-runner`: bounded runner that only uses policy-enforced adapters
- `apps/research-daemon`: completed-run synthesis with provenance metadata

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
- `VITE_SALVO_API_URL`: API URL for dashboard (default `http://localhost:8787`)

## Migrations

Raw SQL migrations live in `supabase/migrations`.

- `0001_bootstrap.sql` bootstrap tables from initial setup
- `0002_runtime_contract.sql` runtime contract tables/indexes, append-only event guard, terminal run immutability
- `0003_daemon_heartbeats.sql` daemon heartbeat table for orchestrator/research health
- `0004_run_cancellation.sql` deferred cancellation marker (`cancellation_requested_at`) for active run cancellation

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
- `POST /runs/:id/retry` to re-queue failed/blocked/cancelled run tasks
- `POST /runs/:id/cancel` (active runs get `run.cancel_requested`; daemon force-cancels and finalizes)
- `POST /tasks/:id/reject` for `needs_review` tasks
- `GET /research`, `POST /research/:id/review`
- `GET /memories`, `POST /memories/:id/review`
- `GET /stream/overview`, `GET /stream/runs/:id` (SSE polling replacement for dashboard updates)

Daemon endpoints are DB-backed via `salvo_daemon_heartbeats` and return `healthy`, `stale`, or `offline`.
