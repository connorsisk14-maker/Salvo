import { Pool, type PoolClient } from "pg";
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

  const wrappedClients = new WeakSet<PoolClient>();

  function decorateClient(client: PoolClient): PoolClient {
    if (wrappedClients.has(client)) {
      return client;
    }
    wrappedClients.add(client);

    const clientQuery = client.query.bind(client);
    client.query = ((...args: any[]) => {
      const hasCallback = typeof args[args.length - 1] === "function";
      const attributes = {
        sql: summarizeSql(args[0])
      };

      return withTelemetrySpan(
        {
          logger,
          name: "db.transaction.query",
          attributes
        },
        async () => {
          if (!hasCallback) {
            return clientQuery(...(args as [any, any?, any?]));
          }

          const callback = args[args.length - 1] as (...callbackArgs: any[]) => void;
          const callbackArgs = args.slice(0, -1);
          return new Promise((resolve, reject) => {
            const wrappedCallback = ((err: unknown, result: unknown) => {
              if (err) {
                reject(err);
                callback(err, result);
                return;
              }

              resolve(result);
              callback(null, result);
            }) as (...callbackArgs: any[]) => void;

            clientQuery(...(callbackArgs as [any, any?]), wrappedCallback);
          });
        }
      );
    }) as typeof client.query;

    return client;
  }

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
  pool.connect = (((...args: unknown[]) => {
    const callback = typeof args[0] === "function" ? args[0] : undefined;
    if (callback) {
      return (originalConnect as (callback: (err: Error | undefined, client: PoolClient | undefined, release: (release?: any) => void) => void) => void)((err, client, release) => {
        if (err || !client) {
          callback(err, client, release);
          return;
        }

        callback(null, decorateClient(client), release);
      });
    }

    return originalConnect().then((client) => decorateClient(client));
  }) as Pool["connect"]);

  return pool;
}
