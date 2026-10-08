import { describe, expect, it, vi } from "vitest";
import { password } from "@inquirer/prompts";
import { createAuthInteraction } from "./auth-interaction";

vi.mock("@inquirer/prompts", () => ({ input: vi.fn(), select: vi.fn(), password: vi.fn() }));

describe("Authentication prompt cancellation", () => {
  it.each(["host", "operation"] as const)(
    "preserves %s cancellation for a masked callback prompt",
    async (source) => {
      const host = new AbortController();
      const operation = new AbortController();
      vi.mocked(password).mockImplementationOnce((_options, context) => {
        const signal = context!.signal!;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }) as ReturnType<typeof password>;
      });
      const pending = createAuthInteraction(host.signal).prompt({
        type: "secret",
        message: "OAuth callback",
        signal: operation.signal,
      });
      (source === "host" ? host : operation).abort(new Error("cancelled"));
      await expect(pending).rejects.toThrow("cancelled");
      expect(password).toHaveBeenLastCalledWith(
        { message: "OAuth callback", mask: "*" },
        expect.anything(),
      );
    },
  );
});
