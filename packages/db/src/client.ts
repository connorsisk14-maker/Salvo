import { Pool } from "pg";
import { createLogger, withTelemetrySpan } from "@salvo/shared";

const logger = createLogger({
  component: "db-client"
});

function summarizeSql(query: unknown): string {
  if (typeof query !== "string") {
    return "sql";
  }

  const firstLine = query.trim().split(/\r?\n/, 1)[0]?.trim() ?? "sql";
  return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 117)}...`;
}

export function createDbPool(databaseUrl = process.env.SALVO_DATABASE_URL): Pool {
  if (!databaseUrl) {
    throw new Error("Missing SALVO_DATABASE_URL environment variable.");
  }

  const pool = new Pool({
    connectionString: databaseUrl
  });

  const originalQuery = pool.query.bind(pool);
  pool.query = (async (...args: Parameters<Pool["query"]>) =>
    withTelemetrySpan(
      {
        logger,
        name: "db.query",
        attributes: {
          sql: summarizeSql(args[0])
        }
      },
      async () => originalQuery(...args)
    )) as Pool["query"];

  const originalConnect = pool.connect.bind(pool);
  pool.connect = (async () => {
    const client = await originalConnect();
    const clientQuery = client.query.bind(client);
    client.query = (async (...args: Parameters<typeof client.query>) =>
      withTelemetrySpan(
        {
          logger,
          name: "db.transaction.query",
          attributes: {
            sql: summarizeSql(args[0])
          }
        },
        async () => clientQuery(...args)
      )) as typeof client.query;
    return client;
  }) as Pool["connect"];

  return pool;
}
