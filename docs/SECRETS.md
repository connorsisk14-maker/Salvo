# Secrets

Salvo supports three secrets backends selected by `SALVO_SECRETS_BACKEND`:

- `env`: read secret values from the shell environment
- `file`: decrypt an encrypted JSON file at startup
- `keychain`: read secret values from the macOS Keychain

Secret values are loaded into the process at startup. Rotation takes effect on the next API or daemon restart.

## Secret Inventory

These values are treated as secrets:

- `SALVO_DATABASE_URL`
- `SALVO_TEST_DATABASE_URL`
- `SALVO_API_TOKEN`
- `SALVO_LLM_API_KEY`
- `SALVO_CLAUDE_AUTH_TOKEN`
- `SALVO_HTTP_TOKEN`
- `SALVO_SUPABASE_ANON_KEY`

Non-secret runtime settings such as ports, log levels, paths, and URLs can remain in `.env`.

## `.env` Guidance

Do not store plaintext secrets in `.env`.

Keep `.env` limited to backend selection and non-secret config, for example:

```dotenv
SALVO_SECRETS_BACKEND=file
SALVO_SECRETS_FILE_PATH=./config/secrets.enc.json
SALVO_WORKSPACE_ROOT=.salvo-workspace
SALVO_API_PORT=8787
SALVO_LOCAL_DB_MODE=external
SALVO_DATABASE_URL=
VITE_SALVO_API_URL=http://localhost:8787
```

Set `SALVO_DATABASE_URL` through your shell environment or secrets backend, then point `pnpm ux:up` at that same local Postgres instance.

If you use the encrypted-file backend, provide `SALVO_SECRETS_FILE_PASSPHRASE` from your shell or terminal session, not from `.env`.

## Backend: `env`

Use this when your launcher or host already injects secrets:

```bash
export SALVO_SECRETS_BACKEND=env
export SALVO_DATABASE_URL='postgres://...'
export SALVO_API_TOKEN='...'
export SALVO_LOCAL_DB_MODE=external
pnpm ux:up
```

## Backend: `file`

1. Create a JSON file containing only secret keys.
2. Export `SALVO_SECRETS_FILE_PASSPHRASE` in your shell.
3. Encrypt the file:

```bash
pnpm secrets:template > secrets.json
# fill in only the secret values you need
export SALVO_SECRETS_FILE_PASSPHRASE='choose-a-strong-passphrase'
pnpm secrets:encrypt --input secrets.json --output config/secrets.enc.json
rm secrets.json
```

At runtime:

```dotenv
SALVO_SECRETS_BACKEND=file
SALVO_SECRETS_FILE_PATH=./config/secrets.enc.json
```

Backup procedure:

- back up `config/secrets.enc.json`
- store the file passphrase separately from the encrypted file
- verify restore by decrypting on a staging or local environment before an incident

Rotation procedure:

1. Update the upstream secret value.
2. Re-encrypt `config/secrets.enc.json`.
3. Restart the API and daemons.

## Backend: `keychain`

This backend is macOS-only and reads generic-password entries using:

- service: `<prefix>.<ENV_KEY>`
- account: `SALVO_SECRETS_KEYCHAIN_ACCOUNT` or `salvo`

Recommended setup:

```bash
security add-generic-password -U -a salvo -s salvo.SALVO_DATABASE_URL -w 'postgres://...'
security add-generic-password -U -a salvo -s salvo.SALVO_API_TOKEN -w '...'
```

Runtime config:

```dotenv
SALVO_SECRETS_BACKEND=keychain
SALVO_SECRETS_KEYCHAIN_SERVICE_PREFIX=salvo
SALVO_SECRETS_KEYCHAIN_ACCOUNT=salvo
```

Rotation procedure:

1. Update the relevant keychain entries with `security add-generic-password -U ...`.
2. Restart the API and daemons.

Backup procedure:

- rely on your macOS keychain backup strategy or device backup
- verify the required entries exist before deployment or recovery
