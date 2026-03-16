# Backups

Salvo writes verified Postgres backups to `SALVO_BACKUP_DIR` or, if unset, `<SALVO_WORKSPACE_ROOT>/backups`.

## Automation

- The orchestrator daemon checks once per minute for a due backup window.
- `SALVO_BACKUP_HOUR_LOCAL` controls the daily local-time run hour.
- Every backup is created with `pg_dump --format=custom --compress=6`.
- Every archive is verified immediately with `pg_restore --list`.
- Retention keeps the newest 7 daily backups and the newest backup from 4 older ISO weeks.

## Manual Trigger

Run a backup through the API:

```bash
curl \
  -H "Authorization: Bearer $SALVO_API_TOKEN" \
  -X POST \
  http://localhost:8787/control/backup
```

Check status:

```bash
curl \
  -H "Authorization: Bearer $SALVO_API_TOKEN" \
  http://localhost:8787/backups/status
```

The Control Center page surfaces the same status, current run state, and recent verified archives.

## Recovery Procedure

1. Stop the API and daemons so nothing writes to the database during recovery.
2. Verify the chosen archive before restore:

```bash
pg_restore --list /absolute/path/to/salvo-postgres-YYYYMMDDTHHMMSSZ.dump
```

3. Restore into the target Postgres database:

```bash
pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --dbname "$SALVO_DATABASE_URL" \
  /absolute/path/to/salvo-postgres-YYYYMMDDTHHMMSSZ.dump
```

4. Start the API and daemons again.
5. Confirm `GET /health`, `GET /health/orchestrator`, and `GET /health/research` are healthy, then inspect `/backups/status` and the Control Center page.
