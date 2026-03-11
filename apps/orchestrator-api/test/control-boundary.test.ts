import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDbPool } from "@salvo/db";
import { buildServer } from "../src/index";

const databaseUrl = process.env.SALVO_TEST_DATABASE_URL ?? process.env.SALVO_DATABASE_URL;

if (!databaseUrl) {
  test("api boundary tests skipped (no SALVO_TEST_DATABASE_URL or SALVO_DATABASE_URL)", { skip: true }, () => {});
} else {
  process.env.SALVO_DATABASE_URL = databaseUrl;

  const pool = createDbPool(databaseUrl);
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

  async function runMigrations(): Promise<void> {
    const migrationDir = path.resolve(rootDir, "supabase/migrations");
    for (const fileName of [
      "0001_bootstrap.sql",
      "0002_runtime_contract.sql",
      "0003_daemon_heartbeats.sql"
    ]) {
      const sql = await readFile(path.join(migrationDir, fileName), "utf8");
      await pool.query(sql);
    }
  }

  async function resetTables(): Promise<void> {
    await pool.query(`
      truncate table
        public.salvo_memories,
        public.salvo_research_documents,
        public.salvo_evaluations,
        public.salvo_artifacts,
        public.salvo_run_events,
        public.salvo_runs,
        public.salvo_contracts,
        public.salvo_tasks,
        public.salvo_daemon_heartbeats,
        public.salvo_workspaces
      restart identity cascade
    `);
  }

  const app = await buildServer();

  before(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await resetTables();
  });

  after(async () => {
    await app.close();
    await pool.end();
  });

  test("control-plane task creation does not create a run", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: {
        title: "boundary-check",
        request: "create task only",
        requiresApproval: false
      }
    });

    assert.equal(createResponse.statusCode, 201);

    const runsResponse = await app.inject({
      method: "GET",
      url: "/runs"
    });

    assert.equal(runsResponse.statusCode, 200);
    const runs = runsResponse.json();
    assert.equal(Array.isArray(runs), true);
    assert.equal(runs.length, 0);
  });

  test("health endpoints return offline when no daemon heartbeat exists", async () => {
    const orchestrator = await app.inject({
      method: "GET",
      url: "/health/orchestrator"
    });

    const research = await app.inject({
      method: "GET",
      url: "/health/research"
    });

    assert.equal(orchestrator.statusCode, 200);
    assert.equal(research.statusCode, 200);
    assert.equal(orchestrator.json().status, "offline");
    assert.equal(research.json().status, "offline");
  });

  test("restart endpoint validates target", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/control/restart",
      payload: {
        target: "invalid"
      }
    });

    assert.equal(response.statusCode, 400);
  });
}
