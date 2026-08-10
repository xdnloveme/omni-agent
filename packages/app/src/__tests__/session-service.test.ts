import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionService } from "../sessions/session-service";

describe("SessionService agent isolation", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restores history only from the selected agent namespace", () => {
    const globalDirectory = mkdtempSync(join(tmpdir(), "omni-agent-sessions-"));
    directories.push(globalDirectory);

    const coding = SessionService.forAgent("coding", globalDirectory);
    coding.restoreLatest();
    coding.appendUserInput("coding context");

    const financial = SessionService.forAgent("financial-analysis", globalDirectory);
    financial.restoreLatest();
    financial.appendUserInput("financial context");

    const restoredCoding = SessionService.forAgent("coding", globalDirectory);
    restoredCoding.restoreLatest();
    const restoredFinancial = SessionService.forAgent("financial-analysis", globalDirectory);
    restoredFinancial.restoreLatest();

    expect(restoredCoding.messages).toEqual([
      expect.objectContaining({ role: "user", content: "coding context" }),
    ]);
    expect(restoredFinancial.messages).toEqual([
      expect.objectContaining({ role: "user", content: "financial context" }),
    ]);
    expect(existsSync(join(globalDirectory, "sessions", "coding", "index.json"))).toBe(true);
    expect(existsSync(join(globalDirectory, "sessions", "financial-analysis", "index.json"))).toBe(
      true,
    );
  });
});
