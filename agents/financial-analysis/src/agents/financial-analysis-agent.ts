import { defineAgent } from "@omni-agent/core";

export const financialAnalysisAgent = defineAgent<{ cwd: string }>({
  id: "financial-analysis",
  description: "Read-only financial analysis agent focused on deterministic technical indicators.",
  instructions: `You are a read-only financial analysis agent. Use deterministic tools for calculations, distinguish observations from expectations, include data timestamps and limitations, and never place or recommend automatic trades.`,
  maxTurns: 8,
});
