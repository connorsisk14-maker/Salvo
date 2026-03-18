# Adding Agent Profiles

1. Agent metadata lives in `packages/shared/src/runtime.ts`: edit `AGENT_PROFILES` to add the profile name, update `DEFAULT_AGENT_TRUST_TIER_BY_PROFILE`, and expand `AGENT_TRUST_TIER_POLICIES` when a new tier is required.
2. Each profile needs a defined prompt, skill hints, and contract defaults under the `AgentProfileDefinition` block later in the file. Keep the prompt explicit about allowed capabilities (filesystem, HTTP, Sheets) to align with policy enforcement.
3. Update `packages/contracts/src/index.ts` if the profile introduces new contract categories or capability combinations that the frontend expects.
4. When adding a lead-gen profile, verify that the new skills (scraper, search, zone expansion) are wired through the `SkillRegistry` and `@salvo/skills` exports so that `packages/db/src/repository.ts` can grant them as allowed `tool_definitions`.

## Operational notes
- Profiles default to the trust tier defined in `packages/shared/src/runtime.ts`. Any profile that needs more permissive tooling (network, DB writes) must be promoted via the control-plane trust-tier API (`POST /trust-tier`).
- Spell out the `AGENT_TRUST_TIER_POLICIES` guarantees (max tool calls, runtime minutes, whether network is allowed) in any onboarding docs so reviewers know when manual approval is needed.
