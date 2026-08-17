import { describe, expect, it, vi } from "vitest";
import type { ConfigService, ModelSelection } from "@omni-agent/app";
import { persistOnboardingSelection } from "./onboarding";

const selection: ModelSelection = {
  vendorId: "vendor",
  connectionId: "default",
  modelId: "model",
};

function configService() {
  return {
    saveAgentModel: vi.fn(async () => undefined),
    saveSharedModel: vi.fn(async () => undefined),
  } as unknown as ConfigService;
}

describe("persistOnboardingSelection", () => {
  it("stores an Agent override globally even when the effective override is project-level", async () => {
    const config = configService();

    await persistOnboardingSelection(config, "coding", selection, {
      selection: { ...selection, modelId: "old" },
      scope: "global",
      kind: "agent",
    });

    expect(config.saveAgentModel).toHaveBeenCalledWith("coding", selection, {
      scope: "global",
    });
    expect(config.saveSharedModel).not.toHaveBeenCalled();
  });

  it("creates or updates the shared global default when no Agent override exists", async () => {
    const config = configService();

    await persistOnboardingSelection(config, "coding", selection, null);

    expect(config.saveSharedModel).toHaveBeenCalledWith(selection, { scope: "global" });
    expect(config.saveAgentModel).not.toHaveBeenCalled();
  });
});
