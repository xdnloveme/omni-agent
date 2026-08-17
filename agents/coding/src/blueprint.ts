import type { AgentBlueprint } from "@omni-agent/app";
import { SkillRuntime } from "@omni-agent/core";
import { createCodingExtension } from "./extension";

export const agentBlueprint = {
  id: "coding",
  async build(context) {
    const runtime = new SkillRuntime({ cwd: context.cwd });
    await runtime.initialize();
    const coding = createCodingExtension(runtime, context.interaction, context.cwd);
    return {
      id: "coding",
      extension: coding.extension,
      capabilities: {
        skills: {
          runtime,
        },
        context: {
          artifactRecovery: {
            toolName: "file_read",
            instruction: "Use file_read on the path when the complete result is needed.",
          },
        },
      },
    };
  },
} satisfies AgentBlueprint;
