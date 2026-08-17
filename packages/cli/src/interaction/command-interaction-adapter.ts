import type {
  CommandInteractionPort,
  CommandSelectionOptions,
  CommandSelectionResult,
  InteractionSurfacePort,
} from "@omni-agent/core";
import { InteractionAbortError } from "@omni-agent/core";
import type { OmniTui } from "./tui/tui";

export class TuiCommandInteractionAdapter implements CommandInteractionPort {
  constructor(
    private readonly tui: OmniTui,
    private readonly surface: InteractionSurfacePort,
  ) {}

  pause(): void {
    this.tui.pause();
  }

  resume(): void {
    this.tui.resume();
  }

  line(text?: string): void {
    this.tui.sink.line(text);
  }

  spacer(): void {
    this.tui.sink.spacer();
  }

  async select(
    options: CommandSelectionOptions,
    signal?: AbortSignal,
  ): Promise<CommandSelectionResult> {
    try {
      const fieldId = "selection";
      const response = await this.surface.request(
        {
          requestId: crypto.randomUUID(),
          title: options.title,
          detail: options.detail,
          message: options.message,
          tone: options.tone,
          fields: [
            {
              type: "single",
              id: fieldId,
              label: options.title,
              options: options.items.map((item) => ({
                id: item.value,
                label: item.label,
                description: item.description,
                tone: item.tone,
              })),
            },
          ],
          completion: { type: "on_select", fieldId },
        },
        signal,
      );
      if (response.kind === "dismissed") return { kind: "escape" };
      const value = response.values[fieldId];
      if (value?.type !== "single" || !value.optionId) {
        throw new Error("Command interaction returned no selection");
      }
      if (!options.items.some((item) => item.value === value.optionId)) {
        throw new Error(`Command interaction returned an unknown selection: ${value.optionId}`);
      }
      return { kind: "selected", value: value.optionId };
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (normalized instanceof InteractionAbortError && normalized.termination === "shutdown") {
        return { kind: "shutdown", error: normalized };
      }
      if (normalized.name === "AbortError") return { kind: "abort", error: normalized };
      throw normalized;
    }
  }
}
