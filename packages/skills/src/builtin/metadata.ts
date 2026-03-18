import { scaffoldModuleSkill } from "./scaffold-module";
import { runTestSuiteSkill } from "./run-test-suite";
import { searchCodebaseSkill } from "./search-codebase";
import { expandZonesSkill } from "./expand-zones";
import { webSearchExtractSkill } from "./web-search-extract";

export type SkillMetadata = {
  name: string;
  label: string;
  description: string;
  inputSchema: Record<string, unknown>;
  example?: Record<string, unknown> | string;
};

export const builtinSkillMetadata: SkillMetadata[] = [
  {
    name: runTestSuiteSkill.name,
    label: "Test Runner",
    description: runTestSuiteSkill.description,
    inputSchema: runTestSuiteSkill.inputSchema,
    example: {
      command: "pnpm test",
      args: ["--filter", "unit"],
      timeoutMs: 120_000
    }
  },
  {
    name: searchCodebaseSkill.name,
    label: "Code Search",
    description: searchCodebaseSkill.description,
    inputSchema: searchCodebaseSkill.inputSchema,
    example: {
      pattern: "TODO",
      path: "apps",
      extensions: ["ts", "tsx"],
      cap: 5
    }
  },
  {
    name: scaffoldModuleSkill.name,
    label: "Module Scaffold",
    description: scaffoldModuleSkill.description,
    inputSchema: scaffoldModuleSkill.inputSchema,
    example: {
      moduleName: "new-feature",
      moduleType: "service",
      targetDirectory: "packages/agent/src"
    }
  },
  {
    name: expandZonesSkill.name,
    label: "Zone Expansion",
    description: expandZonesSkill.description,
    inputSchema: expandZonesSkill.inputSchema,
    example: {
      metro: "dfw",
      limit: 5
    }
  },
  {
    name: webSearchExtractSkill.name,
    label: "Web Search Extract",
    description: webSearchExtractSkill.description,
    inputSchema: webSearchExtractSkill.inputSchema,
    example: {
      query: "hvac repair",
      location: "dallas tx",
      limit: 10
    }
  }
];
