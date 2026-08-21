import { describe, expect, it, vi } from "vitest";
import type { CliHostServices } from "./host-services";
import { main } from "./index";

describe("CLI Host boundary", () => {
  it("delegates Trace preview to the injected Host without importing UI", async () => {
    const runTracePreview = vi.fn(async () => undefined);
    const host = { runTracePreview } as unknown as CliHostServices;

    await main(["trace", "preview", "coding"], host);

    expect(runTracePreview).toHaveBeenCalledExactlyOnceWith("coding");
  });
});
