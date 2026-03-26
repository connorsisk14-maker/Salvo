export * from "./types";
export * from "./registry";
export * from "./builtin/metadata";
export * from "./builtin/scaffold-module";
export * from "./builtin/run-test-suite";
export * from "./builtin/search-codebase";
export * from "./builtin/expand-zones";
export * from "./builtin/web-search-extract";

import { createSkillRegistry } from "./registry";
import { scaffoldModuleSkill } from "./builtin/scaffold-module";
import { runTestSuiteSkill } from "./builtin/run-test-suite";
import { searchCodebaseSkill } from "./builtin/search-codebase";
import { expandZonesSkill } from "./builtin/expand-zones";
import { webSearchExtractSkill } from "./builtin/web-search-extract";

export const builtinSkills = [
  scaffoldModuleSkill,
  runTestSuiteSkill,
  searchCodebaseSkill,
  expandZonesSkill,
  webSearchExtractSkill
] as const;

export function createBuiltinSkillRegistry() {
  return createSkillRegistry(builtinSkills);
}
