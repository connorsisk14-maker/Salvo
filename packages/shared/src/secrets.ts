import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const SECRET_ENV_KEYS = [
  "SALVO_DATABASE_URL",
  "SALVO_TEST_DATABASE_URL",
  "SALVO_API_TOKEN",
  "SALVO_LLM_API_KEY",
  "SALVO_CLAUDE_AUTH_TOKEN",
  "SALVO_HTTP_TOKEN",
  "SALVO_SUPABASE_ANON_KEY"
] as const;

export type SecretEnvKey = (typeof SECRET_ENV_KEYS)[number];
export type SecretsBackend = "env" | "file" | "keychain";

type EncryptedSecretsFile = {
  version: 1;
  algorithm: "aes-256-gcm";
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

type KeychainLookup = (
  service: string,
  account: string
) => Promise<string | null>;

let initializedEnvPromise: Promise<void> | null = null;

function normalizeBackend(input: string | undefined): SecretsBackend {
  if (input === "file" || input === "keychain" || input === "env") {
    return input;
  }
  return "env";
}

function deriveEncryptionKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}

function parseEncryptedSecretsFile(raw: string): EncryptedSecretsFile {
  const parsed = JSON.parse(raw) as Partial<EncryptedSecretsFile>;
  if (
    parsed.version !== 1 ||
    parsed.algorithm !== "aes-256-gcm" ||
    parsed.kdf !== "scrypt" ||
    typeof parsed.salt !== "string" ||
    typeof parsed.iv !== "string" ||
    typeof parsed.tag !== "string" ||
    typeof parsed.ciphertext !== "string"
  ) {
    throw new Error("Invalid encrypted secrets file format.");
  }

  return parsed as EncryptedSecretsFile;
}

export function encryptSecretsPayload(
  secrets: Partial<Record<SecretEnvKey, string>>,
  passphrase: string
): string {
  if (!passphrase.trim()) {
    throw new Error("A non-empty passphrase is required to encrypt secrets.");
  }

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveEncryptionKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(secrets), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload: EncryptedSecretsFile = {
    version: 1,
    algorithm: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function decryptSecretsPayload(
  raw: string,
  passphrase: string
): Partial<Record<SecretEnvKey, string>> {
  if (!passphrase.trim()) {
    throw new Error("A non-empty passphrase is required to decrypt secrets.");
  }

  const payload = parseEncryptedSecretsFile(raw);
  const key = deriveEncryptionKey(passphrase, Buffer.from(payload.salt, "base64"));
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final()
  ]);

  return JSON.parse(decrypted.toString("utf8")) as Partial<Record<SecretEnvKey, string>>;
}

async function defaultKeychainLookup(service: string, account: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      if (stderr.includes("could not be found")) {
        resolve(null);
        return;
      }

      reject(new Error(stderr.trim() || `security exited with code ${code ?? -1}`));
    });
  });
}

async function loadFileSecrets(
  env: NodeJS.ProcessEnv
): Promise<Partial<Record<SecretEnvKey, string>>> {
  const filePath = env.SALVO_SECRETS_FILE_PATH?.trim();
  const passphrase = env.SALVO_SECRETS_FILE_PASSPHRASE?.trim();

  if (!filePath) {
    throw new Error("SALVO_SECRETS_FILE_PATH is required when SALVO_SECRETS_BACKEND=file.");
  }
  if (!passphrase) {
    throw new Error(
      "SALVO_SECRETS_FILE_PASSPHRASE is required when SALVO_SECRETS_BACKEND=file."
    );
  }

  const raw = await readFile(path.resolve(filePath), "utf8");
  return decryptSecretsPayload(raw, passphrase);
}

async function loadKeychainSecrets(
  env: NodeJS.ProcessEnv,
  lookup: KeychainLookup = defaultKeychainLookup
): Promise<Partial<Record<SecretEnvKey, string>>> {
  if (process.platform !== "darwin") {
    throw new Error("SALVO_SECRETS_BACKEND=keychain is only supported on macOS.");
  }

  const prefix = env.SALVO_SECRETS_KEYCHAIN_SERVICE_PREFIX?.trim() || "salvo";
  const account = env.SALVO_SECRETS_KEYCHAIN_ACCOUNT?.trim() || "salvo";
  const secrets: Partial<Record<SecretEnvKey, string>> = {};

  for (const key of SECRET_ENV_KEYS) {
    const service = `${prefix}.${key}`;
    const value = await lookup(service, account);
    if (value) {
      secrets[key] = value;
    }
  }

  return secrets;
}

export async function resolveSecrets(
  env: NodeJS.ProcessEnv = process.env,
  lookup: KeychainLookup = defaultKeychainLookup
): Promise<Partial<Record<SecretEnvKey, string>>> {
  const backend = normalizeBackend(env.SALVO_SECRETS_BACKEND);
  if (backend === "env") {
    return {};
  }

  if (backend === "file") {
    return loadFileSecrets(env);
  }

  return loadKeychainSecrets(env, lookup);
}

export async function loadSecretsIntoEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const secrets = await resolveSecrets(env);
  for (const key of SECRET_ENV_KEYS) {
    const value = secrets[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
}

export async function initializeSecrets(): Promise<void> {
  if (!initializedEnvPromise) {
    initializedEnvPromise = loadSecretsIntoEnv(process.env);
  }

  await initializedEnvPromise;
}
