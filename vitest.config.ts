import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/core/evals/**/*.test.ts",
      "agents/*/src/**/*.test.ts",
      "agents/*/evals/**/*.test.ts",
    ],
    exclude: ["packages/*/dist/**", "agents/*/dist/**", "node_modules/**"],
  },
});
