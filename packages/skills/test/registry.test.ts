import assert from "node:assert/strict";
import test from "node:test";
import { createSkillRegistry, registerSkills, type Skill } from "../src/index";

function createSkill(name: string): Skill {
  return {
    name,
    version: "1.0.0",
    description: `${name} description`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    },
    execute() {
      return {
        ok: true,
        output: {
          name
        },
        artifacts: [],
        events: []
      };
    }
  };
}

test("createSkillRegistry supports register/get/list", () => {
  const alpha = createSkill("alpha");
  const beta = createSkill("beta");
  const registry = createSkillRegistry([alpha]);

  registry.register(beta);

  assert.equal(registry.get("alpha"), alpha);
  assert.equal(registry.get("beta"), beta);
  assert.deepEqual(
    registry.list().map((skill) => skill.name),
    ["alpha", "beta"]
  );
});

test("registerSkills bulk registers and updates duplicate names", () => {
  const registry = createSkillRegistry();

  registerSkills(registry, [
    createSkill("dup"),
    {
      ...createSkill("dup"),
      description: "updated"
    }
  ]);

  assert.equal(registry.list().length, 1);
  assert.equal(registry.get("dup")?.description, "updated");
});
