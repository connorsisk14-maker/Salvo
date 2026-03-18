import assert from "node:assert/strict";
import test from "node:test";
import {
  computeBackupScheduleSlot,
  computeNextScheduledBackupAt,
  deriveBackupState,
  planBackupRetention,
  type BackupFileRecord
} from "../src/backup";

function buildBackup(createdAt: string): BackupFileRecord {
  return {
    file_name: `salvo-postgres-${createdAt.replace(/[-:]/g, "").replace(".000", "").replace(/\.\d+Z$/, "Z")}.dump`,
    path: `/tmp/${createdAt}.dump`,
    created_at: createdAt,
    size_bytes: 123,
    verified_at: createdAt
  };
}

test("computeBackupScheduleSlot snaps to the configured local hour", () => {
  const slot = computeBackupScheduleSlot(new Date("2026-03-16T16:45:00.000Z"), 3);
  assert.equal(slot.getHours(), 3);
  assert.equal(slot.getMinutes(), 0);
  assert.equal(slot.getSeconds(), 0);
});

test("computeNextScheduledBackupAt rolls to the next day once the slot has passed", () => {
  const input = new Date("2026-03-16T16:45:00.000Z");
  const next = computeNextScheduledBackupAt(input, 3);
  assert.equal(next.getHours(), 3);
  assert.equal(next.getMinutes(), 0);
  assert.equal(next.getTime() > input.getTime(), true);
});

test("planBackupRetention keeps the last 7 daily backups and 4 weekly snapshots", () => {
  const now = new Date("2026-03-16T12:00:00.000Z");
  const backups = Array.from({ length: 40 }, (_, index) =>
    buildBackup(new Date(now.getTime() - index * 24 * 60 * 60 * 1000 - 9 * 60 * 60 * 1000).toISOString())
  );

  const result = planBackupRetention(backups, now, 7, 4);

  assert.equal(result.keep.length, 11);
  assert.equal(result.remove.length, 29);
  assert.equal(result.keep[0]?.created_at, backups[0]?.created_at);
});

test("deriveBackupState reports stale when the last successful backup ages out", () => {
  const state = deriveBackupState(
    {
      running: null,
      next_scheduled_at: "2026-03-17T03:00:00.000Z",
      last_run: {
        trigger: "scheduled",
        started_at: "2026-03-14T03:00:00.000Z",
        completed_at: "2026-03-14T03:10:00.000Z",
        success: true,
        error: null,
        backup: null
      }
    },
    new Date("2026-03-16T16:00:00.000Z"),
    24
  );

  assert.equal(state, "stale");
});

test("deriveBackupState reports error for the latest failed run", () => {
  const state = deriveBackupState(
    {
      running: null,
      next_scheduled_at: "2026-03-17T03:00:00.000Z",
      last_run: {
        trigger: "manual",
        started_at: "2026-03-16T12:00:00.000Z",
        completed_at: "2026-03-16T12:01:00.000Z",
        success: false,
        error: "pg_dump failed",
        backup: null
      }
    },
    new Date("2026-03-16T12:05:00.000Z"),
    36
  );

  assert.equal(state, "error");
});
