import assert from "node:assert/strict";
import test from "node:test";
import { buildContractV1 } from "@salvo/contracts";
import { applyTrustTierPolicy, resolveAgentTrustTier } from "../src/trust-tier";

function buildContract() {
  return buildContractV1({
    contractId: "11111111-1111-4111-8111-111111111111",
    taskId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    request: "Install a dependency and update the schema for a debug workflow.",
    taskTitle: "Debug rollout"
  });
}

test("applyTrustTierPolicy clamps runtime and requires review for probation", () => {
  const contract = buildContract();
  const applied = applyTrustTierPolicy(
    {
      ...contract,
      capabilities: {
        ...contract.capabilities,
        install_packages: true,
        network_access: true,
        db_write: true
      },
      constraints: {
        ...contract.constraints,
        max_runtime_minutes: 45,
        max_tool_calls: 100
      }
    },
    "probation"
  );

  assert.equal(applied.requiresManualReview, true);
  assert.equal(applied.contract.constraints.max_runtime_minutes, 10);
  assert.equal(applied.contract.constraints.max_tool_calls, 40);
  assert.equal(applied.contract.capabilities.network_access, false);
  assert.equal(applied.contract.capabilities.install_packages, false);
  assert.equal(applied.contract.capabilities.db_write, false);
  assert.equal(
    applied.contract.constraints.approval_required_for.includes("trust_tier_review"),
    true
  );
});

test("resolveAgentTrustTier falls back to profile default when no row exists", () => {
  assert.equal(resolveAgentTrustTier("builder", null), "standard");
  assert.equal(resolveAgentTrustTier("researcher", undefined), "restricted");
});
