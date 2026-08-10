import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class AtomicJsonFile<T> {
  constructor(
    readonly path: string,
    private readonly mode = 0o600,
  ) {}

  async read(): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as T;
    } catch (error) {
      if (isMissing(error)) return undefined;
      if (error instanceof SyntaxError)
        throw new Error(`Invalid JSON file: ${this.path}`, { cause: error });
      throw error;
    }
  }

  async readText(): Promise<string | undefined> {
    try {
      return await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async write(value: T, beforeCommit?: () => void): Promise<void> {
    await this.writeText(`${JSON.stringify(value, null, 2)}\n`, beforeCommit);
  }

  async writeText(content: string, beforeCommit?: () => void): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: this.mode });
      beforeCommit?.();
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async remove(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
