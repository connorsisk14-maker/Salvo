import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptSecretsPayload,
  encryptSecretsPayload,
  loadSecretsIntoEnv,
  resolveSecrets
} from "../src/secrets";

test("encrypted secrets payload round-trips", () => {
  const encrypted = encryptSecretsPayload(
    {
      SALVO_DATABASE_URL: "postgres://user:pass@localhost:5432/salvo",
      SALVO_API_TOKEN: "token-123"
    },
    "passphrase"
  );

  const decrypted = decryptSecretsPayload(encrypted, "passphrase");
  assert.equal(
    decrypted.SALVO_DATABASE_URL,
    "postgres://user:pass@localhost:5432/salvo"
  );
  assert.equal(decrypted.SALVO_API_TOKEN, "token-123");
});

test("file backend secrets are loaded into an env object", async () => {
  const encrypted = encryptSecretsPayload(
    {
      SALVO_DATABASE_URL: "postgres://file-user:file-pass@localhost:5432/salvo",
      SALVO_API_TOKEN: "file-token"
    },
    "passphrase"
  );

  const env: NodeJS.ProcessEnv = {
    SALVO_SECRETS_BACKEND: "file",
    SALVO_SECRETS_FILE_PASSPHRASE: "passphrase"
  };

  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "salvo-secrets-"));
  const filePath = path.join(dir, "secrets.enc.json");
  await writeFile(filePath, encrypted, "utf8");
  env.SALVO_SECRETS_FILE_PATH = filePath;

  await loadSecretsIntoEnv(env);

  assert.equal(
    env.SALVO_DATABASE_URL,
    "postgres://file-user:file-pass@localhost:5432/salvo"
  );
  assert.equal(env.SALVO_API_TOKEN, "file-token");
});

test("keychain backend resolves prefixed services", async () => {
  if (process.platform === "darwin") {
    const secrets = await resolveSecrets(
      {
        SALVO_SECRETS_BACKEND: "keychain",
        SALVO_SECRETS_KEYCHAIN_SERVICE_PREFIX: "salvo-test",
        SALVO_SECRETS_KEYCHAIN_ACCOUNT: "runner"
      } as NodeJS.ProcessEnv,
      async (service, account) => {
        if (service === "salvo-test.SALVO_API_TOKEN" && account === "runner") {
          return "keychain-token";
        }
        return null;
      }
    );
    assert.equal(secrets.SALVO_API_TOKEN, "keychain-token");
  } else {
    await assert.rejects(
      async () =>
        resolveSecrets(
          {
            SALVO_SECRETS_BACKEND: "keychain"
          } as NodeJS.ProcessEnv,
          async () => null
        ),
      /only supported on macOS/
    );
  }
});
