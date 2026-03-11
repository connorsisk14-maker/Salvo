import { Pool } from "pg";

export function createDbPool(databaseUrl = process.env.SALVO_DATABASE_URL): Pool {
  if (!databaseUrl) {
    throw new Error("Missing SALVO_DATABASE_URL environment variable.");
  }

  return new Pool({
    connectionString: databaseUrl
  });
}
