import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { DbRun, DbTask, SalvoRepository } from "@salvo/db";
import { OrchestratorDaemon } from "../src/index";

class FakeChildProcess {
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  public stdout = new EventEmitter();
  public stderr = new EventEmitter();

  public on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const listener of this.handlers.get(event) ?? []) {
      listener(...args);
    }
  }
}

class TestDaemon extends OrchestratorDaemon {
  public child?: FakeChildProcess;
  public evaluatedRuns: string[] = [];

  constructor(repo: SalvoRepository) {
    super(repo);
  }

  protected spawnRunnerProcess(run: DbRun): ChildProcess {
    const child = new FakeChildProcess();
    this.child = child;
    return child as unknown as ChildProcess;
  }

  protected async evaluateRun(runId: string): Promise<void> {
    this.evaluatedRuns.push(runId);
  }

  public async launch(run: DbRun): Promise<void> {
    await this.launchRun(run);
  }

  public async markBudgetFailure(task: DbTask, error: Error): Promise<void> {
    await this.handleBudgetCheckFailure(task, error);
  }
}

function createRunStub(status: DbRun["status"]): { run: DbRun; task: DbTask; repo: Record<string, unknown> } {
  const run: DbRun = {
    id: `run-${status}`,
    task_id: "task-1",
    contract_id: "contract-1",
    attempt_no: 1,
    agent_profile: "builder",
    status,
    worker_id: null,
    runner_pid: null,
    cancellation_requested_at: null,
    heartbeat_at: null,
    started_at: null,
    ended_at: null,
    exit_reason: null,
    outcome_summary: null,
    score: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const task: DbTask = {
    id: run.task_id,
    workspace_id: "workspace-1",
    title: "Test Task",
    original_request: "Do something",
    normalized_request: "do something",
    status: "queued",
    requires_approval: false,
    approved_at: null,
    cancelled_at: null,
    claimed_by: null,
    claimed_at: null,
    preferred_agent_profile: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    dependency_block_reason: null,
    dependency_blocked_at: null
  };

  const runs = new Map<string, DbRun>([[run.id, run]]);
  const tasks = new Map<string, DbTask>([[task.id, task]]);

  const repo = {
    getRun: async (id: string) => runs.get(id) ?? null,
    transitionRunStatus: async (id: string, status: DbRun["status"]) => {
      const entry = runs.get(id);
      if (entry) {
        entry.status = status;
      }
      return entry ?? null;
    },
    transitionTaskStatus: async (taskId: string, status: DbTask["status"]) => {
      const entry = tasks.get(taskId);
      if (entry) {
        entry.status = status;
      }
      return entry ?? null;
    },
    appendRunEvent: async () => {},
    createAuditEvent: async () => {}
  };

  return { run, task, repo };
}

test("runner close during starting fails run without evaluation", async () => {
  const { run, task, repo } = createRunStub("starting");
  const daemon = new TestDaemon(repo as unknown as SalvoRepository);
  await daemon.launch(run);
  assert(daemon.child, "child should have been created");
  daemon.child!.emit("close", 1, null);
  await new Promise((resolve) => setImmediate(resolve));

  const lookedUpRun = await (repo as any).getRun(run.id);
  assert.equal(lookedUpRun?.status, "failed");
  assert.equal(task.status, "failed");
  assert.equal(daemon.evaluatedRuns.length, 0);
});

test("runner close after terminal status skips evaluation", async () => {
  const { run, task, repo } = createRunStub("completed");
  const daemon = new TestDaemon(repo as unknown as SalvoRepository);
  await daemon.launch(run);
  assert(daemon.child, "child should exist");
  daemon.child!.emit("close", 0, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(daemon.evaluatedRuns.length, 0);
  assert.equal(run.status, "completed");
  assert.equal(task.status, "queued");
});

test("budget check failure marks task as failed", async () => {
  const auditEvents: unknown[] = [];
  const transitions: Array<{ id: string; status: DbTask["status"] }> = [];
  const repo = {
    createAuditEvent: async (event: unknown) => {
      auditEvents.push(event);
    },
    transitionTaskStatus: async (id: string, status: DbTask["status"]) => {
      transitions.push({ id, status });
      return null;
    }
  };
  const daemon = new TestDaemon(repo as unknown as SalvoRepository);
  const task: DbTask = {
    id: "task-budget",
    workspace_id: "ws",
    title: "Budget task",
    original_request: "Budget",
    normalized_request: "budget",
    status: "queued",
    requires_approval: false,
    approved_at: null,
    cancelled_at: null,
    claimed_by: null,
    claimed_at: null,
    preferred_agent_profile: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    dependency_block_reason: null,
    dependency_blocked_at: null
  };

  await daemon.markBudgetFailure(task, new Error("missing llm config"));
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].status, "failed");
  assert.equal(auditEvents.length, 1);
});

test("recoverOrphanedTasksLoop is idempotent", async () => {
  const tasks = [
    { id: "task-1", workspace_id: "ws", claimed_by: "worker-1" },
    { id: "task-2", workspace_id: "ws", claimed_by: "worker-2" }
  ];
  const audits: unknown[] = [];
  const recoverCount = new Map<string, number>();
  const repo = {
    findOrphanedTasks: async () => tasks,
    recoverOrphanedTask: async (id: string) => {
      const count = (recoverCount.get(id) ?? 0) + 1;
      recoverCount.set(id, count);
      return {
        id,
        workspace_id: "ws",
        status: count === 1 ? "queued" : "failed",
        claimed_by: "worker"
      };
    },
    createAuditEvent: async (event: unknown) => {
      audits.push(event);
      return null;
    }
  };
  const daemon = new OrchestratorDaemon(repo as unknown as SalvoRepository);

  await (daemon as unknown as { recoverOrphanedTasksLoop(): Promise<void> }).recoverOrphanedTasksLoop();
  await (daemon as unknown as { recoverOrphanedTasksLoop(): Promise<void> }).recoverOrphanedTasksLoop();
  assert.equal(audits.length, tasks.length);
});
