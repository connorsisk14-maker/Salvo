import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { encryptSecretsPayload, SECRET_ENV_KEYS } from "../packages/shared/src/secrets.ts";

function parseArgs(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) {
      continue;
    }
    flags.set(entry, argv[index + 1]);
    index += 1;
  }
  return flags;
}

async function commandEncrypt(flags) {
  const inputPath = flags.get("--input");
  const outputPath = flags.get("--output");
  const passphrase = process.env.SALVO_SECRETS_FILE_PASSPHRASE ?? "";

  if (!inputPath || !outputPath) {
    throw new Error("Usage: pnpm secrets:encrypt --input secrets.json --output config/secrets.enc.json");
  }
  if (!passphrase.trim()) {
    throw new Error("Set SALVO_SECRETS_FILE_PASSPHRASE in your shell before encrypting.");
  }

  const input = JSON.parse(await readFile(path.resolve(inputPath), "utf8"));
  const secrets = Object.fromEntries(
    SECRET_ENV_KEYS
      .filter((key) => typeof input[key] === "string" && input[key].trim().length > 0)
      .map((key) => [key, input[key]])
  );

  const encrypted = encryptSecretsPayload(secrets, passphrase);
  await writeFile(path.resolve(outputPath), encrypted, "utf8");
  console.log(`[secrets] wrote encrypted secrets to ${path.resolve(outputPath)}`);
}

function commandTemplate() {
  const template = Object.fromEntries(SECRET_ENV_KEYS.map((key) => [key, ""]));
  console.log(JSON.stringify(template, null, 2));
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const flags = parseArgs(rest);

  if (command === "encrypt") {
    await commandEncrypt(flags);
    return;
  }

  if (command === "template") {
    commandTemplate();
    return;
  }

  throw new Error("Usage: pnpm secrets:encrypt --input secrets.json --output config/secrets.enc.json | pnpm secrets:template");
}

await main();
