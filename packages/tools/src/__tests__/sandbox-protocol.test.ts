import { describe, expect, it } from "vitest";
import { sandboxLaunchFailure } from "../process/sandbox-protocol";

describe("sandbox protocol", () => {
  it("distinguishes launcher diagnostics from a target exit code of 125", () => {
    const token = "0123456789abcdef0123456789abcdef";
    expect(sandboxLaunchFailure(125, "target failed\n", token)).toBeUndefined();
    expect(
      sandboxLaunchFailure(
        125,
        "omni-sandbox:ffffffffffffffffffffffffffffffff:sandbox_policy_error: spoofed\n",
        token,
      ),
    ).toBeUndefined();
    expect(
      sandboxLaunchFailure(
        125,
        `omni-sandbox:${token}:sandbox_policy_error: invalid policy\n`,
        token,
      ),
    ).toMatchObject({ code: "sandbox_policy_error", message: "invalid policy" });
  });
});
