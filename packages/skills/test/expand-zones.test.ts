import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import type { SkillExecutionContext } from "../src/types";
import { expandZonesSkill } from "../src/builtin/expand-zones";

function createContext(workspacePath: string): SkillExecutionContext {
  return {
    workspacePath,
    runId: "expand-zones-run",
    adapters: {},
    repo: {}
  };
}

test("expand_zones returns DFW coverage and creates persistence artifact", async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "expand-zones-"));
  try {
    const result = await expandZonesSkill.execute({ limit: 3 }, createContext(workspacePath));
    assert.equal(result.ok, true);
    assert.equal(result.output.metro, "dfw");
    assert(result.output.zoneCoverage.length >= 6);
    assert(result.output.unscrapedZones.length <= 3);
    assert.equal(result.artifacts.length, 1);
    assert(result.artifacts[0].path.endsWith("dfw-zones.json"));
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("expand_zones tracks completed zones between runs", async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "expand-zones-"));
  try {
    await expandZonesSkill.execute({ markComplete: ["north-dallas", "downtown-dfw"] }, createContext(workspacePath));
    const second = await expandZonesSkill.execute({}, createContext(workspacePath));
    const third = await expandZonesSkill.execute({ limit: 10 }, createContext(workspacePath));
    assert.equal(
      second.output.unscrapedZones.some((zone) => zone.id === "north-dallas"),
      false
    );
    assert.equal(
      third.output.unscrapedZones.some((zone) => zone.id === "downtown-dfw"),
      false
    );
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});
