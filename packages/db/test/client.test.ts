import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDbPool, SalvoRepository } from "../src";

const databaseUrl = process.env.SALVO_TEST_DATABASE_URL ?? process.env.SALVO_DATABASE_URL;

if (!databaseUrl) {
  test("db client tests skipped (no SALVO_TEST_DATABASE_URL or SALVO_DATABASE_URL)", { skip: true }, () => {});
} else {
  const pool = createDbPool(databaseUrl);
  const repo = new SalvoRepository(pool);

  after(async () => {
    await pool.end();
  });

  test("createDbPool resolves simple queries", async () => {
    const started = Date.now();
    const result = await Promise.race([
      pool.query("select 1"),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000))
    ]);

    assert.equal((result as { timeout?: boolean }).timeout, undefined);
    assert.ok(Date.now() - started < 5000);
  });

  test("createDbPool resolves repository workspace bootstrapping", async () => {
    const workspaceName = `client-test-${randomUUID()}`;
    const started = Date.now();
    const result = await Promise.race([
      repo.ensureWorkspace(workspaceName, process.cwd()),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000))
    ]);

    assert.equal((result as { timeout?: boolean }).timeout, undefined);
    assert.ok(Date.now() - started < 5000);
  });
}
