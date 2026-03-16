import assert from "node:assert/strict";
import test from "node:test";
import { buildContractV1 } from "@salvo/contracts";
import { buildSystemPrompt } from "../src/index";

function buildContract() {
  return buildContractV1({
    contractId: "11111111-1111-4111-8111-111111111111",
    taskId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    request: "Create a markdown report and run validation tests.",
    taskTitle: "Generate report"
  });
}

test("buildSystemPrompt renders scope, capabilities, and completion protocol", () => {
  const contract = buildContract();
  const prompt = buildSystemPrompt({ contract });

  assert.equal(prompt.includes("## Scope Boundaries"), true);
  assert.equal(prompt.includes("Read paths"), true);
  assert.equal(prompt.includes("Write paths"), true);
  assert.equal(prompt.includes("Forbidden paths"), true);
  assert.equal(prompt.includes("- filesystem_read: granted"), true);
  assert.equal(prompt.includes("- network_access: denied"), true);
  assert.equal(prompt.includes("Required artifacts"), true);
  assert.equal(prompt.includes("Required test commands"), true);
  assert.equal(prompt.includes("salvo_complete"), true);
  assert.equal(prompt.includes("plan_steps"), true);
});

test("buildSystemPrompt only appends optional sections when they are provided", () => {
  const contract = buildContract();
  const withoutOptional = buildSystemPrompt({ contract });
  assert.equal(withoutOptional.includes("## Memory Excerpts"), false);
  assert.equal(withoutOptional.includes("## Prior Run Summaries"), false);

  const withOptional = buildSystemPrompt({
    contract,
    memoryExcerpts: [
      {
        id: "memory-1",
        title: "Prior migration lesson",
        summary: "Avoid touching unrelated files.",
        body: "Keep the patch focused on the requested scope."
      }
    ],
    priorRunSummaries: [
      {
        runId: "run-123",
        summary: "The previous attempt failed because the artifact path was wrong."
      }
    ]
  });

  assert.equal(withOptional.includes("## Memory Excerpts"), true);
  assert.equal(withOptional.includes("Prior migration lesson"), true);
  assert.equal(withOptional.includes("## Prior Run Summaries"), true);
  assert.equal(withOptional.includes("run-123"), true);
  assert.equal(withOptional.includes("artifact path was wrong"), true);
});
