# Salvo Runbook

## Environments

- **Local dev:** set `SALVO_WORKSPACE_ROOT`, `SALVO_API_TOKEN`, and either `SALVO_SECRETS_BACKEND`/keys or plaintext `SALVO_API_TOKEN` as described in `docs/PRODUCTION.md`.
- **Prod-like:** rely on the launchd scripts under `scripts/prod-{preflight,up,down}.mjs` and the templates in `deploy/launchd/`.

## Warm restart checklist
1. Run `pnpm prod:preflight` to verify OS/runtime requirements, migrations, and integrations; the script mirrors the same checks that `prod:up` performs.
2. Apply migrations (if you changed `supabase/migrations/*.sql`) and confirm with `psql` or `pnpm db:migrate` followed by a second run to ensure idempotence.
3. Use `pnpm prod:up` (optionally `--skip-migrations` if you know the DB is current) to render launchd plists, install them via `launchctl`, and verify `http://localhost:$SALVO_API_PORT/health`.
4. On day-to-day restarts, `pnpm prod:down` cleans up existing launchd entries; the scripts ship `launchd` labels for API, orchestrator daemon, and research daemon.

## Emergency/mode verification
- Watch `logs/prod` under the workspace root for each service, and tail `*.err.log` for crash details.
- If the orchestrator or research daemon fails to claim tasks, run `pnpm prod:preflight -- --skip-db` to confirm the runtime environment and secrets backend have been wired.
- Scheduled flows such as the evening planner (`PAC-38`) run once per day; inspect `salvo_audit_events` for `planning.llm_fallback` tags when an LLM response was malformed.

## Known caveats
- The real-LLM CI/smoke step in `.github/workflows/ci.yml` depends on repository secrets (`SALVO_CI_REAL_LLM_API_KEY`). When those values are missing, CI emits a warning and skips the smoke step.
- Load-testing scripts (`scripts/load-test.mjs`) assume a running control plane with a valid `SALVO_API_TOKEN`; manual validation of concurrent tasks remains expensive and is tracked in `docs/PERFORMANCE.md`.
