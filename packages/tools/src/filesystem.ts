import { promises as fs } from "node:fs";
import path from "node:path";
import { evaluateReadPathPolicy, evaluateWritePathPolicy } from "./policy";
import type { FileReadResult, FileWriteResult, ToolPolicy } from "./types";

export class FilesystemAdapter {
  constructor(
    private readonly rootDir: string,
    private readonly policy: ToolPolicy
  ) {}

  resolvePath(targetPath: string): string {
    return path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(this.rootDir, targetPath);
  }

  async readFile(targetPath: string): Promise<FileReadResult> {
    const absolutePath = this.resolvePath(targetPath);
    const decision = evaluateReadPathPolicy(absolutePath, this.policy);
    if (!decision.allowed) {
      return { ok: false, decision };
    }

    const content = await fs.readFile(absolutePath, "utf8");
    return {
      ok: true,
      content,
      absolutePath
    };
  }

  async writeFile(targetPath: string, content: string): Promise<FileWriteResult> {
    const absolutePath = this.resolvePath(targetPath);
    const decision = evaluateWritePathPolicy(absolutePath, this.policy);
    if (!decision.allowed) {
      return { ok: false, decision };
    }

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");

    return {
      ok: true,
      absolutePath
    };
  }

  async ensureDir(targetPath: string): Promise<void> {
    const absolutePath = this.resolvePath(targetPath);
    const decision = evaluateWritePathPolicy(absolutePath, this.policy);
    if (!decision.allowed) {
      throw new Error(decision.message);
    }

    await fs.mkdir(absolutePath, { recursive: true });
  }

  async ensureDirectory(targetPath: string): Promise<void> {
    await this.ensureDir(targetPath);
  }

  async mkdir(targetPath: string): Promise<void> {
    await this.ensureDir(targetPath);
  }

  async createDirectory(targetPath: string): Promise<void> {
    await this.ensureDir(targetPath);
  }

  async listDirectory(targetPath = "."): Promise<FileReadResult> {
    const absolutePath = this.resolvePath(targetPath);
    const decision = evaluateReadPathPolicy(absolutePath, this.policy);
    if (!decision.allowed) {
      return { ok: false, decision };
    }

    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const content = entries
      .map((entry) => `${entry.isDirectory() ? "dir" : "file"}: ${entry.name}`)
      .join("\n");

    return {
      ok: true,
      content,
      absolutePath
    };
  }
}
