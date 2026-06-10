import {
  SKILL_TOOL_NAME,
  SkillEventName,
  SkillEventNamespace,
  SkillReadStatus,
  SkillSourceScope,
  type AgentConfig,
  type CommandRegistry,
  type ExtensionEvent,
  type SkillSource,
  type SkillRuntime,
  type StreamCallbacks,
} from "@omni-agent/core";
import type { OmniTui, SlashCommand } from "../tui";
import { createSkillsCommand } from "../commands/skills";
import { renderSkillReadEnd, renderSkillReadStart } from "./skill-renderer";

export interface SkillCliControllerOptions {
  skillRuntime: SkillRuntime;
  commandRegistry: CommandRegistry;
  tui: OmniTui;
  agentConfig: AgentConfig;
  buildSystemPrompt: () => Promise<string>;
}

export class SkillCliController {
  private readonly skillRuntime: SkillRuntime;
  private readonly commandRegistry: CommandRegistry;
  private readonly tui: OmniTui;
  private readonly agentConfig: AgentConfig;
  private readonly buildSystemPrompt: () => Promise<string>;

  constructor(options: SkillCliControllerOptions) {
    this.skillRuntime = options.skillRuntime;
    this.commandRegistry = options.commandRegistry;
    this.tui = options.tui;
    this.agentConfig = options.agentConfig;
    this.buildSystemPrompt = options.buildSystemPrompt;
  }

  registerCommands(): void {
    this.commandRegistry.register(createSkillsCommand(this.skillRuntime.registry, async () => {
      this.agentConfig.systemPrompt = await this.buildSystemPrompt();
      this.refreshAutocomplete();
    }));
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

  async resolveSlashPreload(input: string): Promise<{ displayInput: string; modelInput: string } | null> {
    const preload = await this.skillRuntime.resolveSlashPreload(input);
    if (!preload) return null;

    renderSkillReadStart(this.tui.sink, preload.skill.name);
    renderSkillReadEnd(this.tui.sink, {
      skillName: preload.skill.name,
      status: preload.status,
      source: preload.skill.source,
      filePath: preload.skill.filePath,
      tokenEstimate: preload.skill.tokenEstimate,
    }, "explicit");

    return {
      displayInput: preload.displayInput,
      modelInput: preload.modelInput,
    };
  }

  shouldSuppressToolPreview(toolName: string): boolean {
    return toolName === SKILL_TOOL_NAME;
  }

  streamCallbacks(): Pick<StreamCallbacks, "onExtensionEvent"> {
    return {
      onExtensionEvent: (event) => this.handleExtensionEvent(event),
    };
  }

  private handleExtensionEvent(event: ExtensionEvent): void {
    if (event.namespace !== SkillEventNamespace.Skill) return;

    if (event.event === SkillEventName.ReadStart) {
      const skillName = getString(event.payload, "skillName");
      this.tui.sink.line();
      renderSkillReadStart(this.tui.sink, skillName);
      this.tui.setStatus(`reading skill: ${skillName}...`);
      return;
    }

    if (event.event === SkillEventName.ReadEnd) {
      renderSkillReadEnd(this.tui.sink, {
        skillName: getString(event.payload, "skillName"),
        status: getSkillReadStatus(event.payload),
        source: getSkillSource(event.payload.source),
        filePath: getOptionalString(event.payload, "filePath"),
        durationMs: getOptionalNumber(event.payload, "durationMs"),
        tokenEstimate: getOptionalNumber(event.payload, "tokenEstimate"),
        error: getOptionalString(event.payload, "error"),
      });
      this.tui.setStatus("thinking...");
    }
  }
}

function getString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function getOptionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function getOptionalNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" ? value : undefined;
}

function getSkillReadStatus(payload: Record<string, unknown>): "loaded" | "cached" | "failed" {
  const status = payload.status;
  if (status === SkillReadStatus.Cached || status === SkillReadStatus.Failed) return status;
  return SkillReadStatus.Loaded;
}

function getSkillSource(value: unknown): SkillSource | undefined {
  if (!value || typeof value !== "object") return undefined;
  const scope = (value as { scope?: unknown }).scope;
  if (
    scope !== SkillSourceScope.Project &&
    scope !== SkillSourceScope.User &&
    scope !== SkillSourceScope.Plugin
  ) {
    return undefined;
  }
  return value as SkillSource;
}
