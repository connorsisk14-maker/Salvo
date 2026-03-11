# Salvo v1 (Enforcement-First Harness)

Local-first agentic harness with a strict runtime contract, policy-enforced adapters, deterministic evaluation, and provenance-safe research synthesis.

## Components

- `apps/web`: Vite dashboard (Control Center + Run Detail)
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

- `0002_runtime_contract.sql` creates runtime tables, indexes, append-only event guard, and terminal run immutability trigger.

## Local Run

```bash
pnpm install
pnpm dev:api
pnpm dev:orchestrator
pnpm dev:research
pnpm dev:dashboard
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

Daemon endpoints are DB-backed via `salvo_daemon_heartbeats` and return `healthy`, `stale`, or `offline`.
