import type { AgentFactory } from "@omni-agent/app";
import { SkillRuntime } from "@omni-agent/core";
import { createCodingExtension } from "./extension";

export const agentFactory = {
  async create(options) {
    const runtime = new SkillRuntime({ cwd: options.cwd });
    await runtime.initialize();
    const coding = createCodingExtension(runtime, options.cwd);

    return {
      agentId: "coding",
      extension: coding.extension,
      skills: {
        runtime,
        buildSystemPrompt: coding.buildSystemPrompt,
      },
    };
  },
} satisfies AgentFactory<unknown>;
