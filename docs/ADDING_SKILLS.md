# Adding Skills

1. Implement the new skill inside `packages/skills/src/builtin/` and follow the existing shape (`Skill` exports, `inputSchema`, `.execute`).
2. Emit structured artifacts/events for any persistence or notable side effect so the agent loop can report progress.
3. Register the skill by re-exporting it via `packages/skills/src/index.ts` so the orchestrator’s skill registry can import it.
4. Add a test under `packages/skills/test/` that drives the skill through mocked adapters (`filesystem`, `http`, etc.). Run `pnpm --filter @salvo/skills test` to keep coverage aligned with the other core skills.
5. Update any dashboards or API surfaces that surface skills; new references to `SkillRegistry` behavior can be found in `apps/web/src/pages/SkillsPage.tsx` once implemented.

## Caveats
- Registers must stay synchronous with the registry helpers in `packages/skills/src/registry.ts`; avoid side effects during module load to keep the daemon startup predictable.
- Adapters expected by the skill (HTTP, Google Sheets, command, filesystem) should be configurable via `context.adapters` so unit tests can stub them.
