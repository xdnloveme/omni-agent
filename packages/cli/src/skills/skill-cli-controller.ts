import { type CommandRegistry, type SkillRuntime } from "@omni-agent/core";
import type { AgentConsolePort, CommandDescriptor, TextPresentationPort } from "../host-services";
import { createSkillsCommand } from "../commands/skills";

export interface SkillCliControllerOptions {
  skillRuntime: SkillRuntime;
  commandRegistry: CommandRegistry;
  console: AgentConsolePort;
  text: TextPresentationPort;
  refreshInstructions: () => Promise<void>;
}

export class SkillCliController {
  private readonly skillRuntime: SkillRuntime;
  private readonly commandRegistry: CommandRegistry;
  private readonly console: AgentConsolePort;
  private readonly text: TextPresentationPort;
  private readonly refreshInstructions: () => Promise<void>;

  constructor(options: SkillCliControllerOptions) {
    this.skillRuntime = options.skillRuntime;
    this.commandRegistry = options.commandRegistry;
    this.console = options.console;
    this.text = options.text;
    this.refreshInstructions = options.refreshInstructions;
  }

  registerCommands(): void {
    this.commandRegistry.register(
      createSkillsCommand(this.skillRuntime.registry, this.text, async () => {
        await this.refreshInstructions();
        this.refreshAutocomplete();
      }),
    );
  }

  refreshAutocomplete(): void {
    const builtins = this.commandRegistry.list().map((c): CommandDescriptor => ({
      name: c.name,
      description: c.description,
    }));
    const skillCommands = this.skillRuntime.registry
      .list()
      .filter((skill) => skill.userInvocable)
      .map((skill): CommandDescriptor => ({ name: skill.name, description: skill.description }));
    this.console.setCommandCatalog([...builtins, ...skillCommands]);
  }

  async resolveSlashPreload(
    input: string,
  ): Promise<{ displayInput: string; modelInput: string } | null> {
    const preload = await this.skillRuntime.resolveSlashPreload(input);
    if (!preload) return null;

    this.console.presentSkillRead({
      skillName: preload.skill.name,
      status: preload.status,
      source: preload.skill.source,
      filePath: preload.skill.filePath,
      tokenEstimate: preload.skill.tokenEstimate,
      mode: "explicit",
    });

    return {
      displayInput: preload.displayInput,
      modelInput: preload.modelInput,
    };
  }
}
