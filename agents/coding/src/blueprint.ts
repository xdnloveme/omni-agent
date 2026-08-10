import type { AgentBlueprint } from "@omni-agent/app";
import { SkillRuntime } from "@omni-agent/core";
import { createCodingExtension } from "./extension";

export const agentBlueprint = {
  id: "coding",
  async build(context) {
    const runtime = new SkillRuntime({ cwd: context.cwd });
    await runtime.initialize();
    const coding = createCodingExtension(runtime, context.cwd);
    return {
      id: "coding",
      extension: coding.extension,
      capabilities: {
        skills: {
          runtime,
          buildSystemPrompt: coding.buildSystemPrompt,
        },
      },
    };
  },
} satisfies AgentBlueprint;
