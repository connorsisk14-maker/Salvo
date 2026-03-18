import { spawn } from "node:child_process";
import { access, mkdir, open, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type BackupTrigger = "scheduled" | "manual";
export type BackupState = "pending" | "running" | "healthy" | "stale" | "error";

export type BackupConfig = {
  databaseUrl: string | null;
  workspaceRoot: string;
  backupDir: string;
  scheduleHourLocal: number;
  retentionDaily: number;
  retentionWeekly: number;
  staleAfterHours: number;
  pgDumpCommand: string;
  pgRestoreCommand: string;
};

export type BackupFileRecord = {
  file_name: string;
  path: string;
  created_at: string;
  size_bytes: number;
  verified_at: string;
};

export type BackupRunRecord = {
  trigger: BackupTrigger;
  started_at: string;
  completed_at: string;
  success: boolean;
  error: string | null;
  backup: BackupFileRecord | null;
};

export type BackupStatus = {
  state: BackupState;
  storage_dir: string;
  schedule_hour_local: number;
  next_scheduled_at: string;
  retention: {
    daily: number;
    weekly: number;
  };
  running: {
    pid: number;
    trigger: BackupTrigger;
    started_at: string;
  } | null;
  last_run: BackupRunRecord | null;
  recent_backups: BackupFileRecord[];
};

type BackupStatusFile = {
  version: 1;
  next_scheduled_at: string;
  running: BackupStatus["running"];
  last_run: BackupRunRecord | null;
  backups: BackupFileRecord[];
};

type CommandRunner = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }
) => Promise<void>;

export class BackupAlreadyRunningError extends Error {
  readonly lockInfo?: BackupStatus["running"];

  constructor(message: string, lockInfo?: BackupStatus["running"]) {
    super(message);
    this.name = "BackupAlreadyRunningError";
    this.lockInfo = lockInfo ?? undefined;
  }
}

const STATUS_FILE_NAME = "status.json";
const LOCK_FILE_NAME = "backup.lock";
const BACKUP_FILE_PREFIX = "salvo-postgres-";
const BACKUP_FILE_EXTENSION = ".dump";

function clampHour(input: number): number {
  if (!Number.isFinite(input)) {
    return 3;
  }
  return Math.min(23, Math.max(0, Math.floor(input)));
}

function readPositiveIntegerEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const value = Number(env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function readBackupConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  const workspaceRoot = env.SALVO_WORKSPACE_ROOT ?? process.cwd();
  return {
    databaseUrl: env.SALVO_DATABASE_URL?.trim() ? env.SALVO_DATABASE_URL.trim() : null,
    workspaceRoot,
    backupDir: path.resolve(env.SALVO_BACKUP_DIR ?? path.join(workspaceRoot, "backups")),
    scheduleHourLocal: clampHour(Number(env.SALVO_BACKUP_HOUR_LOCAL ?? 3)),
    retentionDaily: readPositiveIntegerEnv("SALVO_BACKUP_RETENTION_DAILY", 7, env),
    retentionWeekly: readPositiveIntegerEnv("SALVO_BACKUP_RETENTION_WEEKLY", 4, env),
    staleAfterHours: readPositiveIntegerEnv("SALVO_BACKUP_STALE_AFTER_HOURS", 36, env),
    pgDumpCommand: env.SALVO_BACKUP_PG_DUMP_COMMAND?.trim() || "pg_dump",
    pgRestoreCommand: env.SALVO_BACKUP_PG_RESTORE_COMMAND?.trim() || "pg_restore"
  };
}

export function computeBackupScheduleSlot(input: Date, hourLocal: number): Date {
  const slot = new Date(input);
  slot.setHours(hourLocal, 0, 0, 0);
  return slot;
}

export function computeNextScheduledBackupAt(input: Date, hourLocal: number): Date {
  const slot = computeBackupScheduleSlot(input, hourLocal);
  if (slot.getTime() > input.getTime()) {
    return slot;
  }

  const next = new Date(slot);
  next.setDate(next.getDate() + 1);
  return next;
}

function computeInitialScheduledBackupAt(input: Date, hourLocal: number): Date {
  return computeNextScheduledBackupAt(input, hourLocal);
}

function formatTimestampForFile(input: Date): string {
  return input
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function parseBackupTimestamp(fileName: string): Date | null {
  if (!fileName.startsWith(BACKUP_FILE_PREFIX) || !fileName.endsWith(BACKUP_FILE_EXTENSION)) {
    return null;
  }

  const raw = fileName.slice(BACKUP_FILE_PREFIX.length, -BACKUP_FILE_EXTENSION.length);
  const match = /^(\d{8})T(\d{6})Z$/.exec(raw);
  if (!match) {
    return null;
  }

  const [, datePart, timePart] = match;
  const parsed = new Date(
    `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}T${timePart.slice(0, 2)}:${timePart.slice(2, 4)}:${timePart.slice(4, 6)}Z`
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getIsoWeekKey(input: Date): string {
  const date = new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function planBackupRetention(
  backups: BackupFileRecord[],
  now = new Date(),
  retentionDaily = 7,
  retentionWeekly = 4
): {
  keep: BackupFileRecord[];
  remove: BackupFileRecord[];
} {
  const sorted = [...backups].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const cutoffMs = now.getTime() - retentionDaily * 24 * 60 * 60 * 1000;
  const weeklyKeep = new Set<string>();
  const keep: BackupFileRecord[] = [];
  const remove: BackupFileRecord[] = [];

  for (const backup of sorted) {
    const createdAt = new Date(backup.created_at);
    if (Number.isNaN(createdAt.getTime())) {
      remove.push(backup);
      continue;
    }

    if (createdAt.getTime() >= cutoffMs) {
      keep.push(backup);
      continue;
    }

    const weekKey = getIsoWeekKey(createdAt);
    if (weeklyKeep.size < retentionWeekly && !weeklyKeep.has(weekKey)) {
      weeklyKeep.add(weekKey);
      keep.push(backup);
      continue;
    }

    remove.push(backup);
  }

  return { keep, remove };
}

export function deriveBackupState(
  status: Pick<BackupStatus, "running" | "last_run" | "next_scheduled_at">,
  now = new Date(),
  staleAfterHours = 36
): BackupState {
  if (status.running) {
    return "running";
  }

  const lastRun = status.last_run;
  if (!lastRun) {
    return "pending";
  }

  if (!lastRun.success) {
    return "error";
  }

  const completedAt = new Date(lastRun.completed_at);
  if (Number.isNaN(completedAt.getTime())) {
    return "error";
  }

  const staleAfterMs = staleAfterHours * 60 * 60 * 1000;
  if (now.getTime() - completedAt.getTime() > staleAfterMs) {
    return "stale";
  }

  return "healthy";
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: ["ignore", "ignore", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code ?? -1}`));
    });
  });
}

export class BackupManager {
  private readonly config: BackupConfig;
  private readonly runner: CommandRunner;

  constructor(config = readBackupConfig(), runner: CommandRunner = runCommand) {
    this.config = config;
    this.runner = runner;
  }

  async getStatus(): Promise<BackupStatus> {
    await this.ensureStorage();
    const normalized = await this.loadNormalizedStatus();
    return this.toPublicStatus(normalized);
  }

  async runScheduledBackupIfDue(now = new Date()): Promise<BackupRunRecord | null> {
    const status = await this.getStatus();
    const dueAt = new Date(status.next_scheduled_at);

    if (Number.isNaN(dueAt.getTime()) || now.getTime() < dueAt.getTime()) {
      return null;
    }

    try {
      return await this.runBackup("scheduled", now);
    } catch (error) {
      if (error instanceof BackupAlreadyRunningError) {
        return null;
      }
      throw error;
    }
  }

  async runManualBackup(now = new Date()): Promise<BackupRunRecord> {
    return this.runBackup("manual", now);
  }

  private async runBackup(trigger: BackupTrigger, startedAt: Date): Promise<BackupRunRecord> {
    if (!this.config.databaseUrl) {
      throw new Error("SALVO_DATABASE_URL must be configured before backups can run.");
    }

    await this.ensureStorage();
    const startedAtIso = startedAt.toISOString();
    const lock = await this.acquireLock({
      pid: process.pid,
      trigger,
      started_at: startedAtIso
    });

    let dumpPath: string | null = null;
    try {
      const status = await this.readStatusFile();
      const nextScheduledAt = this.computeNextScheduledAfterRun(startedAt, status.next_scheduled_at);
      await this.writeStatusFile({
        ...status,
        running: lock,
        next_scheduled_at: nextScheduledAt
      });

      const fileName = `${BACKUP_FILE_PREFIX}${formatTimestampForFile(startedAt)}${BACKUP_FILE_EXTENSION}`;
      dumpPath = path.join(this.config.backupDir, fileName);

      await this.runner(
        this.config.pgDumpCommand,
        ["--format=custom", "--compress=6", "--file", dumpPath, this.config.databaseUrl],
        {
          cwd: this.config.workspaceRoot,
          env: process.env
        }
      );

      await this.runner(this.config.pgRestoreCommand, ["--list", dumpPath], {
        cwd: this.config.workspaceRoot,
        env: process.env
      });

      const dumpStats = await stat(dumpPath);
      const completedAtIso = new Date().toISOString();
      const backupRecord: BackupFileRecord = {
        file_name: fileName,
        path: dumpPath,
        created_at: startedAtIso,
        size_bytes: dumpStats.size,
        verified_at: completedAtIso
      };

      const nextStatus = await this.readStatusFile();
      const retained = await this.applyRetention([backupRecord, ...nextStatus.backups], new Date(completedAtIso));
      const lastRun: BackupRunRecord = {
        trigger,
        started_at: startedAtIso,
        completed_at: completedAtIso,
        success: true,
        error: null,
        backup: backupRecord
      };

      await this.writeStatusFile({
        ...nextStatus,
        running: null,
        next_scheduled_at: this.computeNextScheduledAfterRun(startedAt, nextStatus.next_scheduled_at),
        last_run: lastRun,
        backups: retained
      });

      return lastRun;
    } catch (error) {
      if (dumpPath && (await pathExists(dumpPath))) {
        await rm(dumpPath, { force: true });
      }

      const failedAt = new Date().toISOString();
      const current = await this.readStatusFile();
      const lastRun: BackupRunRecord = {
        trigger,
        started_at: startedAtIso,
        completed_at: failedAt,
        success: false,
        error: (error as Error).message,
        backup: null
      };
      await this.writeStatusFile({
        ...current,
        running: null,
        next_scheduled_at: this.computeNextScheduledAfterRun(startedAt, current.next_scheduled_at),
        last_run: lastRun
      });
      throw error;
    } finally {
      await this.releaseLock();
    }
  }

  private computeNextScheduledAfterRun(startedAt: Date, currentNextScheduledAt: string): string {
    const current = new Date(currentNextScheduledAt);
    if (!Number.isNaN(current.getTime()) && startedAt.getTime() < current.getTime()) {
      return current.toISOString();
    }

    return computeNextScheduledBackupAt(startedAt, this.config.scheduleHourLocal).toISOString();
  }

  private async applyRetention(backups: BackupFileRecord[], now: Date): Promise<BackupFileRecord[]> {
    const deduped = Array.from(new Map(backups.map((backup) => [backup.path, backup])).values());
    const { keep, remove } = planBackupRetention(
      deduped,
      now,
      this.config.retentionDaily,
      this.config.retentionWeekly
    );

    await Promise.all(
      remove.map(async (backup) => {
        if (await pathExists(backup.path)) {
          await unlink(backup.path);
        }
      })
    );

    return keep.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  private async ensureStorage(): Promise<void> {
    await mkdir(this.config.backupDir, { recursive: true });
    const statusPath = path.join(this.config.backupDir, STATUS_FILE_NAME);
    if (await pathExists(statusPath)) {
      return;
    }

    const initialStatus: BackupStatusFile = {
      version: 1,
      next_scheduled_at: computeInitialScheduledBackupAt(
        new Date(),
        this.config.scheduleHourLocal
      ).toISOString(),
      running: null,
      last_run: null,
      backups: await this.readBackupFilesFromDisk()
    };
    await this.writeStatusFile(initialStatus);
  }

  private async readBackupFilesFromDisk(): Promise<BackupFileRecord[]> {
    const entries = await readdir(this.config.backupDir, { withFileTypes: true });
    const backups: BackupFileRecord[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const createdAt = parseBackupTimestamp(entry.name);
      if (!createdAt) {
        continue;
      }

      const absolutePath = path.join(this.config.backupDir, entry.name);
      const fileStats = await stat(absolutePath);
      backups.push({
        file_name: entry.name,
        path: absolutePath,
        created_at: createdAt.toISOString(),
        size_bytes: fileStats.size,
        verified_at: fileStats.mtime.toISOString()
      });
    }

    return backups.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  private async readStatusFile(): Promise<BackupStatusFile> {
    await this.ensureStorage();
    const statusPath = path.join(this.config.backupDir, STATUS_FILE_NAME);
    const payload = JSON.parse(await readFile(statusPath, "utf8")) as Partial<BackupStatusFile>;
    return {
      version: 1,
      next_scheduled_at:
        payload.next_scheduled_at ??
        computeInitialScheduledBackupAt(new Date(), this.config.scheduleHourLocal).toISOString(),
      running: payload.running ?? null,
      last_run: payload.last_run ?? null,
      backups: Array.isArray(payload.backups) ? payload.backups : []
    };
  }

  private async writeStatusFile(status: BackupStatusFile): Promise<void> {
    const statusPath = path.join(this.config.backupDir, STATUS_FILE_NAME);
    await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  }

  private async loadNormalizedStatus(): Promise<BackupStatusFile> {
    const status = await this.readStatusFile();
    const backupsOnDisk = await this.readBackupFilesFromDisk();
    const existingByPath = new Map(status.backups.map((backup) => [backup.path, backup]));
    const merged = backupsOnDisk.map((backup) => existingByPath.get(backup.path) ?? backup);
    const running = await this.readActiveLock();
    const nextScheduledAt =
      status.next_scheduled_at ||
      computeInitialScheduledBackupAt(new Date(), this.config.scheduleHourLocal).toISOString();

    const normalized: BackupStatusFile = {
      ...status,
      running,
      next_scheduled_at: nextScheduledAt,
      backups: merged.sort((a, b) => b.created_at.localeCompare(a.created_at))
    };

    await this.writeStatusFile(normalized);
    return normalized;
  }

  private async readActiveLock(): Promise<BackupStatus["running"]> {
    const lockPath = path.join(this.config.backupDir, LOCK_FILE_NAME);
    if (!(await pathExists(lockPath))) {
      return null;
    }

    try {
      const payload = JSON.parse(await readFile(lockPath, "utf8")) as BackupStatus["running"];
      if (!payload || typeof payload.pid !== "number") {
        await unlink(lockPath);
        return null;
      }

      if (this.isProcessAlive(payload.pid)) {
        return payload;
      }

      await unlink(lockPath);
      return null;
    } catch {
      await rm(lockPath, { force: true });
      return null;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async acquireLock(lockInfo: NonNullable<BackupStatus["running"]>): Promise<NonNullable<BackupStatus["running"]>> {
    const lockPath = path.join(this.config.backupDir, LOCK_FILE_NAME);
    const activeLock = await this.readActiveLock();
    if (activeLock) {
      throw new BackupAlreadyRunningError("A backup is already running.", activeLock);
    }

    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify(lockInfo, null, 2)}\n`, "utf8");
      await handle.close();
      return lockInfo;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const currentLock = await this.readActiveLock();
        throw new BackupAlreadyRunningError("A backup is already running.", currentLock);
      }
      throw error;
    }
  }

  private async releaseLock(): Promise<void> {
    const lockPath = path.join(this.config.backupDir, LOCK_FILE_NAME);
    await rm(lockPath, { force: true });
  }

  private toPublicStatus(status: BackupStatusFile): BackupStatus {
    return {
      state: deriveBackupState(status, new Date(), this.config.staleAfterHours),
      storage_dir: this.config.backupDir,
      schedule_hour_local: this.config.scheduleHourLocal,
      next_scheduled_at: status.next_scheduled_at,
      retention: {
        daily: this.config.retentionDaily,
        weekly: this.config.retentionWeekly
      },
      running: status.running,
      last_run: status.last_run,
      recent_backups: status.backups.slice(0, 12)
    };
  }
}
