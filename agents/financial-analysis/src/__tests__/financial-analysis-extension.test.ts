import { describe, expect, it } from "vitest";
import { RejectingInteractionSurface } from "@omni-agent/core";
import { createFinancialAnalysisExtension } from "../extension";

describe("financial analysis extension", () => {
  it("registers clarification after the deterministic read-only tool", () => {
    const extension = createFinancialAnalysisExtension(new RejectingInteractionSurface());
    expect(extension.contributions.tools?.map((tool) => tool.name)).toEqual([
      "financial_compute_technical_indicators",
      "request_user_input",
    ]);
    expect(extension.contributions.agents?.[0]?.tools.include).toEqual([
      "financial_compute_technical_indicators",
      "request_user_input",
    ]);
  });
});
