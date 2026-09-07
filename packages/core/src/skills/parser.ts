import { constants, type Stats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseSkillMarkdown } from "./frontmatter";
import type { SkillMetadata, SkillSource } from "./types";

export interface SkillDraft {
  filePath: string;
  fallbackName: string;
  source: SkillSource;
  sourceRoot: SkillMetadata["sourceRoot"];
  version: string;
  frontmatter: Record<string, unknown>;
  body: string;
  bodyComplete: boolean;
}

const MAX_METADATA_BYTES = 64 * 1024;
const MAX_SKILL_FILE_BYTES = 512 * 1024;

export class SkillParser {
  async parse(
    filePath: string,
    fallbackName: string,
    source: SkillSource,
    options: { fullBody?: boolean; sourceRoot?: SkillMetadata["sourceRoot"] } = {},
  ): Promise<SkillDraft> {
    const rootPath = await realpath(source.path);
    const rootInfo = await stat(rootPath);
    const sourceRoot = options.sourceRoot ?? {
      path: rootPath,
      dev: rootInfo.dev,
      ino: rootInfo.ino,
    };
    const verifyRoot = async () => {
      const currentPath = await realpath(source.path);
      const info = await stat(currentPath);
      if (
        currentPath !== sourceRoot.path ||
        info.dev !== sourceRoot.dev ||
        info.ino !== sourceRoot.ino
      )
        throw new Error("Skill source root changed: " + source.path);
    };
    await verifyRoot();
    const canonicalFile = await realpath(filePath);
    const relative = path.relative(sourceRoot.path, canonicalFile);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
      throw new Error("Skill file escapes its source root: " + filePath);
    const handle = await open(
      canonicalFile,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error("Skill must be a regular file: " + filePath);
      if (options.fullBody && before.size > MAX_SKILL_FILE_BYTES)
        throw new Error(
          "Skill file exceeds the " + MAX_SKILL_FILE_BYTES + "-byte read limit: " + filePath,
        );
      const length = options.fullBody ? before.size : Math.min(before.size, MAX_METADATA_BYTES);
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      await verifyRoot();
      const currentFile = await realpath(filePath);
      const currentInfo = await stat(currentFile);
      if (
        offset !== length ||
        !sameVersion(before, after) ||
        currentFile !== canonicalFile ||
        currentInfo.dev !== after.dev ||
        currentInfo.ino !== after.ino
      )
        throw new Error("Skill changed while being read: " + filePath);
      const raw = buffer.toString("utf8");
      const parsed = parseSkillMarkdown(raw);
      return {
        filePath: canonicalFile,
        fallbackName,
        source,
        sourceRoot,
        version: createHash("sha256").update(buffer).digest("hex"),
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        bodyComplete: before.size <= length,
      };
    } finally {
      await handle.close();
    }
  }
}

function sameVersion(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
