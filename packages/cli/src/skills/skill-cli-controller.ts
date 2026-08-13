import { type CommandRegistry, type SkillRuntime } from "@omni-agent/core";
import type { OmniTui, SlashCommand } from "../interaction/tui/tui";
import { createSkillsCommand } from "../commands/skills";
import { renderSkillReadEnd, renderSkillReadStart } from "./skill-renderer";

export interface SkillCliControllerOptions {
  skillRuntime: SkillRuntime;
  commandRegistry: CommandRegistry;
  tui: OmniTui;
  refreshInstructions: () => Promise<void>;
}

export class SkillCliController {
  private readonly skillRuntime: SkillRuntime;
  private readonly commandRegistry: CommandRegistry;
  private readonly tui: OmniTui;
  private readonly refreshInstructions: () => Promise<void>;

  constructor(options: SkillCliControllerOptions) {
    this.skillRuntime = options.skillRuntime;
    this.commandRegistry = options.commandRegistry;
    this.tui = options.tui;
    this.refreshInstructions = options.refreshInstructions;
  }

  registerCommands(): void {
    this.commandRegistry.register(
      createSkillsCommand(this.skillRuntime.registry, async () => {
        await this.refreshInstructions();
        this.refreshAutocomplete();
      }),
    );
  }

  refreshAutocomplete(): void {
    const builtins = this.commandRegistry.list().map((c): SlashCommand => ({
      name: c.name,
      description: c.description,
    }));
    const skillCommands = this.skillRuntime.registry
      .list()
      .filter((skill) => skill.userInvocable)
      .map((skill): SlashCommand => ({ name: skill.name, description: skill.description }));
    this.tui.setCommands([...builtins, ...skillCommands]);
  }

  async resolveSlashPreload(
    input: string,
  ): Promise<{ displayInput: string; modelInput: string } | null> {
    const preload = await this.skillRuntime.resolveSlashPreload(input);
    if (!preload) return null;

    renderSkillReadStart(this.tui.sink, preload.skill.name);
    renderSkillReadEnd(
      this.tui.sink,
      {
        skillName: preload.skill.name,
        status: preload.status,
        source: preload.skill.source,
        filePath: preload.skill.filePath,
        tokenEstimate: preload.skill.tokenEstimate,
      },
      "explicit",
    );

    return {
      displayInput: preload.displayInput,
      modelInput: preload.modelInput,
    };
  }
}
