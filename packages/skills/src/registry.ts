import type { Skill, SkillRegistry } from "./types";

export function createSkillRegistry(initialSkills: Iterable<Skill> = []): SkillRegistry {
  const skills = new Map<string, Skill>();

  for (const skill of initialSkills) {
    skills.set(skill.name, skill);
  }

  return {
    register(skill: Skill): void {
      skills.set(skill.name, skill);
    },
    get(name: string): Skill | undefined {
      return skills.get(name);
    },
    list(): Skill[] {
      return Array.from(skills.values());
    }
  };
}

export function registerSkills(registry: SkillRegistry, skills: Iterable<Skill>): void {
  for (const skill of skills) {
    registry.register(skill);
  }
}
