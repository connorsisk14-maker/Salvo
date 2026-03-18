# SALVO Launchd Templates

These are template plists used by `scripts/prod-up.mjs`.

- Do not load these template files directly with `launchctl`.
- `prod-up` renders concrete plists into `~/Library/LaunchAgents`.
- `prod-down` unloads those services and removes rendered plists.

Template placeholders:

- `__ROOT_DIR__`: absolute repository root
- `__PNPM_BIN__`: absolute `pnpm` executable path
- `__PATH__`: runtime PATH for launchd service processes
- `__LOG_DIR__`: directory for service stdout/stderr logs
- `__ENV_VARS__`: rendered `<key>/<string>` launchd env entries
