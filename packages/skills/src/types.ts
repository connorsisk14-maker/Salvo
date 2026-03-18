export type SkillArtifact = {
  path: string;
  artifactType?: string;
  metadata?: Record<string, unknown>;
};

export type SkillEvent = {
  type: string;
  level?: "debug" | "info" | "warn" | "error";
  payload?: Record<string, unknown>;
};

export type SkillExecutionContext = {
  workspacePath: string;
  runId: string;
  adapters: Record<string, unknown>;
  repo: Record<string, unknown>;
};

export type SkillResult<TOutput = Record<string, unknown>> = {
  ok: boolean;
  output: TOutput;
  artifacts: SkillArtifact[];
  events: SkillEvent[];
};

export type Skill<TInput = Record<string, unknown>, TOutput = Record<string, unknown>> = {
  name: string;
  version: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(
    input: TInput,
    context: SkillExecutionContext
  ): Promise<SkillResult<TOutput>> | SkillResult<TOutput>;
};

export type SkillRegistry = {
  register(skill: Skill): void;
  get(name: string): Skill | undefined;
  list(): Skill[];
};

export class InMemorySkillRegistry implements SkillRegistry {
  readonly #skills = new Map<string, Skill>();

  register(skill: Skill): void {
    this.#skills.set(skill.name, skill);
  }

  get(name: string): Skill | undefined {
    return this.#skills.get(name);
  }

  list(): Skill[] {
    return Array.from(this.#skills.values());
  }
}
