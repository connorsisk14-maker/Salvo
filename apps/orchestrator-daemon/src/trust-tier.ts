import type { ContractV1 } from "@salvo/contracts";
import {
  AGENT_TRUST_TIER_POLICIES,
  DEFAULT_AGENT_TRUST_TIER_BY_PROFILE,
  type AgentProfile,
  type AgentTrustTier,
  type AgentTrustTierPolicy
} from "@salvo/shared";

export type AppliedTrustTier = {
  trustTier: AgentTrustTier;
  policy: AgentTrustTierPolicy;
  contract: ContractV1;
  requiresManualReview: boolean;
};

export function resolveAgentTrustTier(
  agentProfile: AgentProfile,
  trustTier?: AgentTrustTier | null
): AgentTrustTier {
  return trustTier ?? DEFAULT_AGENT_TRUST_TIER_BY_PROFILE[agentProfile];
}

export function applyTrustTierPolicy(
  contract: ContractV1,
  trustTier: AgentTrustTier
): AppliedTrustTier {
  const policy = AGENT_TRUST_TIER_POLICIES[trustTier];
  const approvalRequiredFor = new Set(contract.constraints.approval_required_for);

  if (policy.requiresApproval) {
    approvalRequiredFor.add("trust_tier_review");
  }

  return {
    trustTier,
    policy,
    requiresManualReview: policy.requiresApproval,
    contract: {
      ...contract,
      capabilities: {
        ...contract.capabilities,
        network_access: contract.capabilities.network_access && policy.networkAccess,
        install_packages: contract.capabilities.install_packages && policy.installPackages,
        run_tests: contract.capabilities.run_tests && policy.runTests,
        db_write: contract.capabilities.db_write && policy.dbWrite,
        slack_send: contract.capabilities.slack_send && policy.networkAccess
      },
      constraints: {
        ...contract.constraints,
        max_runtime_minutes: Math.min(
          contract.constraints.max_runtime_minutes,
          policy.maxRuntimeMinutes
        ),
        max_tool_calls: Math.min(contract.constraints.max_tool_calls, policy.maxToolCalls),
        approval_required_for: Array.from(approvalRequiredFor)
      },
      success_criteria: {
        ...contract.success_criteria,
        required_test_commands: policy.runTests
          ? contract.success_criteria.required_test_commands
          : []
      }
    }
  };
}
