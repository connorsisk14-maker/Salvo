import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { initializeSecrets } from "../packages/shared/src/secrets.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(rootDir, "supabase", "migrations");

async function main(): Promise<void> {
  await initializeSecrets();
  const databaseUrl = process.env.SALVO_DATABASE_URL ?? process.env.SALVO_TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing SALVO_DATABASE_URL (or SALVO_TEST_DATABASE_URL) for migrations.");
  }

  const files = (await readdir(migrationsDir))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("[migrate] no SQL files found.");
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    for (const fileName of files) {
      const sql = await readFile(path.join(migrationsDir, fileName), "utf8");
      await pool.query(sql);
      console.log(`[migrate] applied ${fileName}`);
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(`[migrate] failed: ${(error as Error).message}`);
  process.exit(1);
});
