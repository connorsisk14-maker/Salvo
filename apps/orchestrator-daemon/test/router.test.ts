import assert from "node:assert/strict";
import test from "node:test";
import { routeAgentProfiles } from "../src/router";

test("routeAgentProfiles filters by required capabilities", () => {
  const result = routeAgentProfiles({
    contractCapabilities: {
      filesystem_write: true,
      db_write: true
    }
  });

  assert.equal(result.selectedProfile, "builder");
  assert.equal(result.rankedCandidates.length, 1);
  assert.equal(result.rankedCandidates[0].profile, "builder");
  assert.ok(
    result.rankedCandidates[0].reasons.some((value) =>
      value.toLowerCase().includes("capabilities")
    )
  );
});

test("routeAgentProfiles honors preferred profile hints", () => {
  const result = routeAgentProfiles({
    preferredProfile: "researcher",
    contractCategory: "general"
  });

  assert.equal(result.selectedProfile, "researcher");
  assert.match(result.reasoning, /preferred profile/i);
  assert.equal(result.rankedCandidates[0].profile, "researcher");
});

test("routeAgentProfiles boosts profiles with strong history", () => {
  const result = routeAgentProfiles({
    contractCategory: "operations",
    taskPriority: 3,
    history: [
      {
        profile: "lead_strategist",
        successRate: 0.95,
        runCount: 8
      }
    ]
  });

  assert.equal(result.selectedProfile, "lead_strategist");
  assert.ok(result.rankedCandidates.some((candidate) => candidate.profile === "ops"));
  assert.ok(result.rankedCandidates[0].reasons.some((value) => value.toLowerCase().includes("history")));

  for (let i = 1; i < result.rankedCandidates.length; i++) {
    const previous = result.rankedCandidates[i - 1];
    const current = result.rankedCandidates[i];
    assert.ok(current.score <= previous.score);
  }
});

test("routeAgentProfiles can override the planner profile when category history is stronger", () => {
  const result = routeAgentProfiles({
    plannedProfile: "builder",
    contractCategory: "documentation",
    taskTitle: "Write the worker pool runbook",
    history: [
      {
        profile: "documenter",
        successRate: 0.98,
        runCount: 6,
        averageScore: 94,
        averageCostUsd: 0.2,
        matchScope: "category"
      }
    ]
  });

  assert.equal(result.selectedProfile, "documenter");
  assert.match(result.reasoning, /documenter/i);
});
