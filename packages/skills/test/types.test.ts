import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemorySkillRegistry,
  type Skill,
  type SkillExecutionContext,
  type SkillResult
} from "../src/index";

const context: SkillExecutionContext = {
  workspacePath: "/tmp/workspace",
  runId: "run-123",
  adapters: {
    filesystem: {}
  },
  repo: {
    appendRunEvent: () => {}
  }
};

function createSkill(name: string): Skill<{ task: string }, { summary: string }> {
  return {
    name,
    version: "1.0.0",
    description: `${name} skill`,
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string"
        }
      }
    },
    async execute(input): Promise<SkillResult<{ summary: string }>> {
      return {
        ok: true,
        output: {
          summary: input.task
        },
        artifacts: [],
        events: []
      };
    }
  };
}

test("InMemorySkillRegistry supports register/get/list", async () => {
  const registry = new InMemorySkillRegistry();
  const skill = createSkill("example_skill");

  registry.register(skill);

  assert.equal(registry.get("example_skill")?.name, "example_skill");
  assert.deepEqual(
    registry.list().map((entry) => entry.name),
    ["example_skill"]
  );

  const result = await registry.get("example_skill")?.execute(
    {
      task: "hello"
    },
    context
  );
  assert.equal(result?.ok, true);
  assert.equal(result?.output.summary, "hello");
});

test("register replaces an existing skill with the same name", () => {
  const registry = new InMemorySkillRegistry();

  registry.register(createSkill("dup_skill"));
  registry.register({
    ...createSkill("dup_skill"),
    description: "updated"
  });

  assert.equal(registry.list().length, 1);
  assert.equal(registry.get("dup_skill")?.description, "updated");
});
