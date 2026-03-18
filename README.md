# Salvo v1 (Enforcement-First Harness)

Local-first agentic harness with a strict runtime contract, policy-enforced adapters, deterministic evaluation, and provenance-safe research synthesis.

## Components

- `apps/web`: Vite dashboard (Control Center, Tasks & Runs Board, Research Review, Integrations, Run Detail)
- `apps/orchestrator-api`: control-plane API (`create/read/approve/cancel` + read run/contract/event state)
- `apps/orchestrator-daemon`: task claim loop, contract generation, runner spawn, evaluation, retry
- `apps/agent-runner`: bounded runner that only uses policy-enforced adapters

## Lead Pipeline

The DFW lead pipeline relies on `docs/LEAD_PIPELINE_TEMPLATE.md`, which describes the raw intake, enrichment, zone tracking, and run history tabs plus the seeded zone priorities and creation steps. After copying the template into your workspace, target the copy by setting `SALVO_LEAD_PIPELINE_SHEET_ID` with the new spreadsheet ID in your environment or orchestration layer. Update `packages/shared/src/lead-pipeline.ts` whenever the template layout or zone list changes so automation code and docs stay in sync.

Dashboard polish currently emphasizes the light, high-contrast feel used across the Control Center; dark mode has been deferred until after the remaining panels are fully wired.
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

- `SALVO_SECRETS_BACKEND`: secret source (`env`, `file`, or `keychain`)
- `SALVO_WORKSPACE_ROOT`: local path used for run workspaces and artifacts
- `SALVO_LOG_LEVEL`: structured log threshold (`debug`, `info`, `warn`, `error`)
- `SALVO_LOG_TARGET`: structured log output target (`stdout`, `stderr`, or `split`)
- `SALVO_BACKUP_DIR`: optional filesystem path for verified database backups
- `SALVO_BACKUP_HOUR_LOCAL`: daily backup hour in local server time (default `3`)
- `SALVO_BACKUP_RETENTION_DAILY`: number of daily archives to keep (default `7`)
- `SALVO_BACKUP_RETENTION_WEEKLY`: number of weekly archives to keep after daily retention (default `4`)
- `SALVO_API_IDEMPOTENCY_TTL_HOURS`: how long idempotent responses are replayable (default `24`)
- `SALVO_RECOVERY_ORPHAN_RUN_AFTER_SECONDS`: stale/orphan run timeout for recovery (default `30`)
- `SALVO_RECOVERY_ORPHAN_TASK_AFTER_SECONDS`: planning task recovery timeout when no run exists (default `120`)
- `SALVO_RECOVERY_MAX_RUN_ATTEMPTS`: max attempts before stale runs are exhausted (default `2`)
- `VITE_SALVO_API_URL`: API URL for dashboard (default `http://localhost:8787`)

Secret values such as `SALVO_DATABASE_URL`, `SALVO_API_TOKEN`, `SALVO_LLM_API_KEY`, and adapter tokens should not be stored in plaintext `.env`. Use the configured secrets backend instead. See [docs/SECRETS.md](/Users/connorsisk/Desktop/SALVO/docs/SECRETS.md).

For local bootstrap, `.env.example` only documents optional overrides. The `ux:*` commands synthesize safe local defaults in-process when values are absent:

- `SALVO_LOCAL_DB_MODE=docker` unless you explicitly set `external`
- `SALVO_LOCAL_LLM_MODE=fake` unless you explicitly set `real`
- `SALVO_DATABASE_URL` and `SALVO_TEST_DATABASE_URL` pointing at the managed local Postgres container when DB mode is `docker`
- `SALVO_API_TOKEN=local-dev-token` for local control-plane auth
- `SALVO_LLM_PROVIDER=anthropic`, `SALVO_LLM_API_KEY=fake-key`, and `SALVO_LLM_BASE_URL=http://127.0.0.1:9797` in fake-LLM mode

## Migrations

Raw SQL migrations live in `supabase/migrations`.

- `0001_bootstrap.sql` bootstrap tables from initial setup
- `0002_runtime_contract.sql` runtime contract tables/indexes, append-only event guard, terminal run immutability
- `0003_daemon_heartbeats.sql` daemon heartbeat table for orchestrator/research health
- `0004_run_cancellation.sql` deferred cancellation marker (`cancellation_requested_at`) for active run cancellation
- `0005_integration_configs.sql` integration configuration storage
- `0006_llm_api_integration_cutover.sql` `claude_local -> llm_api` migration with compatibility merge
- `0007_research_analysis_pipeline.sql` research ingestion/experiment tables + contract-family memory scope
- `0008_idempotency_recovery.sql` idempotency record storage + recovery support metadata

## UX Quick Start

Use the deterministic UX pipeline for local setup instead of booting each service manually:

```bash
pnpm install
pnpm ux:doctor
pnpm ux:up
pnpm ux:smoke
pnpm ux:status
pnpm ux:down
pnpm ux:clean
```

Command behavior:

1. `pnpm ux:doctor` runs a non-mutating preflight and supports `--json`.
2. `pnpm ux:db:up` provisions or starts the Docker-backed local Postgres container `salvo-postgres`, binds it to `localhost:54329`, and ensures `salvo_test` exists.
3. `pnpm ux:llm:up` starts the fake Anthropic-compatible LLM server and records its PID in `.salvo-workspace/dev/pids.json`.
4. `pnpm ux:up` composes doctor, DB bootstrap, migrations, fake LLM bootstrap when enabled, and background startup for the API, orchestrator, research daemon, and dashboard.
5. `pnpm ux:smoke` runs the authenticated fake-LLM smoke flow.
6. `pnpm ux:status` reports PID state first, then probes control-plane health. The detailed daemon health endpoints are authenticated.
7. `pnpm ux:down` stops processes launched through `ux:up`.
8. `pnpm ux:clean` removes generated local runtime artifacts under `.salvo-workspace/dev`, `.salvo-workspace/logs`, `.salvo-workspace/runs`, and backup status files.

Override the local defaults only when needed:

- Set `SALVO_LOCAL_DB_MODE=external` if you want to use an existing Postgres instance and provide `SALVO_DATABASE_URL`.
- Set `SALVO_LOCAL_LLM_MODE=real` if you want to use a live provider and provide `SALVO_LLM_API_KEY` plus any required base URL overrides.

The fake provider responds on `/health` so the stack can detect it before starting agents.

## Checks

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

`pnpm test:e2e` expects the authenticated control-plane path. When you use `pnpm ux:up`, it automatically exports matching local values for `SALVO_E2E_API_URL` and `SALVO_E2E_API_TOKEN`.

## Secrets Management

- `SALVO_SECRETS_BACKEND=env`: reads secrets directly from the shell environment
- `SALVO_SECRETS_BACKEND=file`: decrypts `SALVO_SECRETS_FILE_PATH` using `SALVO_SECRETS_FILE_PASSPHRASE`
- `SALVO_SECRETS_BACKEND=keychain`: reads from macOS Keychain using `SALVO_SECRETS_KEYCHAIN_SERVICE_PREFIX`

Helper commands:

```bash
pnpm secrets:template > secrets.json
export SALVO_SECRETS_FILE_PASSPHRASE='choose-a-strong-passphrase'
pnpm secrets:encrypt --input secrets.json --output config/secrets.enc.json
```

## Daemon Health

Control-plane health endpoints:

- `GET /health`
- `GET /health/orchestrator`
- `GET /health/research`
- `POST /control/restart` with body `{ "target": "orchestrator" | "research" | "all" }`
- `POST /tasks` accepts `idempotency_key` or `idempotency-key` for 24h replay
- `GET /backups/status`, `POST /control/backup` for verified database backups
- `POST /runs/:id/retry` to re-queue failed/blocked/cancelled run tasks
- `POST /runs/:id/cancel` (active runs get `run.cancel_requested`; daemon force-cancels and finalizes)
- `POST /tasks/:id/reject` for `needs_review` tasks
- `GET /research`, `POST /research/:id/review`
- `GET /research/experiments`, `POST /research/experiments/:id/review`
- `GET /memories`, `POST /memories/:id/review`
- `GET /stream/overview`, `GET /stream/runs/:id` (SSE polling replacement for dashboard updates)

`GET /health` is public. The daemon detail endpoints and control operations require a bearer token from `SALVO_API_TOKEN`. Daemon endpoints are DB-backed via `salvo_daemon_heartbeats` and return `healthy`, `stale`, or `offline`.

The orchestrator also re-queues orphaned planning tasks and recovers orphaned/stale runs using configurable thresholds, with each recovery action written to `audit_events`.

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
