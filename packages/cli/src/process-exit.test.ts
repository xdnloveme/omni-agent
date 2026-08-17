import { describe, expect, it } from "vitest";
import { exitCodeForTermination } from "./process-exit";

describe("exitCodeForTermination", () => {
  it("maps interactive and signal termination to process exit codes", () => {
    expect(exitCodeForTermination({ kind: "completed" })).toBe(0);
    expect(exitCodeForTermination({ kind: "user_interrupt" })).toBe(130);
    expect(exitCodeForTermination({ kind: "signal", signal: "SIGTERM" })).toBe(143);
  });
});
