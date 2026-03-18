# Production Deployment (macOS launchd)

This project includes one-command production lifecycle scripts:

- `pnpm prod:preflight`
- `pnpm prod:up`
- `pnpm prod:down`

These commands target macOS `launchd` services for:

- `com.salvo.orchestrator-api`
- `com.salvo.orchestrator-daemon`
- `com.salvo.research-daemon`

Templates are stored in [deploy/launchd/README.md](/Users/connorsisk/Desktop/SALVO/deploy/launchd/README.md).

## Startup Order

`pnpm prod:up` performs:

1. Production preflight checks (platform, launchctl, pnpm, env, DB, schema, integrations).
2. Database migrations (`pnpm db:migrate`) unless `--skip-migrations` is passed.
3. Render/install launchd plists into `~/Library/LaunchAgents`.
4. `launchctl bootstrap` + `kickstart` for API, orchestrator daemon, and research daemon.
5. API health probe (`/health`) before reporting success.

`pnpm prod:down` performs:

1. `launchctl bootout` for all three services.
2. Remove installed plists from `~/Library/LaunchAgents` (unless `--keep-plists`).

## Environment Template

Use this as a production-oriented baseline (prefer secrets backend over plaintext secrets):

```bash
# secrets backend mode: env | file | keychain
SALVO_SECRETS_BACKEND=keychain

# required runtime identity/config
SALVO_WORKSPACE_ROOT=/absolute/path/to/salvo-workspace
SALVO_API_PORT=8787
SALVO_API_TOKEN=replace-with-control-plane-token

# database secret source
SALVO_DATABASE_URL=postgres://user:pass@host:5432/salvo

# if SALVO_SECRETS_BACKEND=file
SALVO_SECRETS_FILE_PATH=/absolute/path/to/secrets.enc.json
SALVO_SECRETS_FILE_PASSPHRASE=replace-with-passphrase

# if SALVO_SECRETS_BACKEND=keychain
SALVO_SECRETS_KEYCHAIN_SERVICE_PREFIX=salvo
SALVO_SECRETS_KEYCHAIN_ACCOUNT=salvo

# optional LLM fallback (integration config is preferred)
SALVO_LLM_PROVIDER=anthropic
SALVO_LLM_API_KEY=replace-with-llm-key
SALVO_LLM_DEFAULT_MODEL=claude-3-5-sonnet-latest

# optional health/recovery tuning
SALVO_HEALTH_ORCHESTRATOR_STALE_SECONDS=15
SALVO_HEALTH_RESEARCH_STALE_SECONDS=45
SALVO_RECOVERY_ORPHAN_RUN_AFTER_SECONDS=30
SALVO_RECOVERY_ORPHAN_TASK_AFTER_SECONDS=120
SALVO_RECOVERY_MAX_RUN_ATTEMPTS=2
```

## Preflight Coverage

`pnpm prod:preflight` verifies:

- macOS + `launchctl` + `pnpm` availability
- `SALVO_DATABASE_URL` (or `SALVO_TEST_DATABASE_URL`)
- `SALVO_API_TOKEN`
- migration files found in `supabase/migrations`
- DB connectivity and presence of core runtime tables
- integration presence (`llm_api`, `process`, `http`) and LLM credential source

Useful flags:

- `pnpm prod:preflight -- --json`
- `pnpm prod:preflight -- --strict-llm`
- `pnpm prod:preflight -- --skip-db`

## Service Logs

By default, launchd service logs go to:

- `${SALVO_WORKSPACE_ROOT}/logs/prod/orchestrator-api.out.log`
- `${SALVO_WORKSPACE_ROOT}/logs/prod/orchestrator-api.err.log`
- `${SALVO_WORKSPACE_ROOT}/logs/prod/orchestrator-daemon.out.log`
- `${SALVO_WORKSPACE_ROOT}/logs/prod/orchestrator-daemon.err.log`
- `${SALVO_WORKSPACE_ROOT}/logs/prod/research-daemon.out.log`
 - `${SALVO_WORKSPACE_ROOT}/logs/prod/research-daemon.err.log`

## Health Monitoring

The control plane now exposes `GET /health/all`, which reports the health status of `orchestrator`, `research`, and the database connection plus timestamps and thresholds. Configure an external poller to hit that endpoint every 60 seconds and alert when any service is `stale` or `offline`.

Use `pnpm health:monitor` (or run `node scripts/monitor-health.mjs`) for the built-in poller. The script accepts:

- `SALVO_HEALTH_MONITOR_API_URL` (default `http://localhost:8787`)
- `SALVO_HEALTH_MONITOR_INTERVAL_MS` (default `60000`)
- `SALVO_HEALTH_ALERT_CHANNELS` (comma-separated: `stdout`, `slack`, `email`)
- `SALVO_HEALTH_SLACK_WEBHOOK_URL` (required when `slack` is enabled)
- `SALVO_HEALTH_EMAIL_TRANSPORT_URL`, `SALVO_HEALTH_EMAIL_FROM`, `SALVO_HEALTH_EMAIL_RECIPIENTS` (required when `email` is enabled)
- `SALVO_HEALTH_RESTART_LOCK_PATH` (create this file prior to a planned restart to suppress alerts during outage windows)

Alerts are emitted when a service degrades from `healthy` or when the overall health becomes non-healthy, with a resolution message when the service recovers.
