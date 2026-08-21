import {
  InteractionAbortError,
  InteractionError,
  validateInteractionRequest,
  validateInteractionResponse,
  type CommandSelectionOptions,
  type InteractionField,
  type InteractionRequest,
  type InteractionResponse,
  type InteractionSurfacePort,
  type InteractionValue,
} from "@omni-agent/core";
import type { OmniTui } from "../runtime/tui";

export class TuiInteractionSurface implements InteractionSurfacePort {
  private activeAbort: AbortController | null = null;

  constructor(private readonly tui: OmniTui) {}

  async request(request: InteractionRequest, signal?: AbortSignal): Promise<InteractionResponse> {
    validateInteractionRequest(request);
    if (this.activeAbort) {
      throw new InteractionError("interaction_busy", "Another foreground interaction is active");
    }
    const ownedAbort = new AbortController();
    this.activeAbort = ownedAbort;
    if (request.status) this.tui.setStatus(request.status);
    const linkedSignal = signal ? AbortSignal.any([signal, ownedAbort.signal]) : ownedAbort.signal;
    try {
      const values: Record<string, InteractionValue> = {};
      for (const [index, field] of request.fields.entries()) {
        const result = await this.collectField(request, field, index === 0, linkedSignal);
        if (result.kind === "dismissed") return this.validated(request, result);
        values[field.id] = result.value;
        if (request.completion.type === "on_select" && request.completion.fieldId === field.id) {
          return this.validated(request, {
            requestId: request.requestId,
            kind: "completed",
            values,
          });
        }
      }
      if (request.completion.type === "on_complete") {
        return this.validated(request, {
          requestId: request.requestId,
          kind: "completed",
          values,
        });
      }
      if (request.completion.type !== "explicit") {
        throw new InteractionError(
          "invalid_interaction_request",
          "on_select completion field was not collected",
        );
      }
      const action = await this.tui.select(
        {
          title: request.title,
          detail: request.detail,
          message: request.message,
          tone: request.tone,
          dismissLabel: request.dismissLabel,
          items: request.completion.actions.map((item) => ({
            value: item.id,
            label: item.label,
            tone: item.tone,
          })),
        },
        linkedSignal,
      );
      if (action.kind === "abort" || action.kind === "shutdown") this.terminate(action);
      if (action.kind === "escape") return this.dismissed(request);
      return this.validated(request, {
        requestId: request.requestId,
        kind: "completed",
        actionId: action.value,
        values,
      });
    } finally {
      if (this.activeAbort === ownedAbort) this.activeAbort = null;
    }
  }

  dispose(): void {
    this.activeAbort?.abort();
    this.activeAbort = null;
  }

  private async collectField(
    request: InteractionRequest,
    field: InteractionField,
    first: boolean,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "completed"; readonly value: InteractionValue }
    | Extract<InteractionResponse, { kind: "dismissed" }>
  > {
    if (field.type === "text") {
      const presentation = this.fieldPresentation(request, field, first);
      const result = await this.tui.textInput(
        {
          ...presentation,
          placeholder: field.placeholder,
          acceptsEmpty: field.required !== true,
        },
        signal,
      );
      if (result.kind === "abort" || result.kind === "shutdown") this.terminate(result);
      if (result.kind === "escape") return this.dismissed(request);
      return { kind: "completed", value: { type: "text", text: result.text } };
    }

    const otherValue = field.allowOther
      ? createInternalValue(field.options.map((option) => option.id))
      : undefined;
    const items = [
      ...field.options.map((option) => ({
        value: option.id,
        label: option.label,
        description: option.description,
        tone: option.tone,
      })),
      ...(otherValue
        ? [
            {
              value: otherValue,
              label: "Other…",
              description:
                field.type === "multiple"
                  ? "Space to select, then Enter to type"
                  : "Press Enter to type a custom answer",
            },
          ]
        : []),
    ];
    const presentation = this.fieldPresentation(request, field, first);
    if (field.type === "single") {
      const result = await this.tui.select(
        { ...presentation, items } satisfies CommandSelectionOptions,
        signal,
      );
      if (result.kind === "abort" || result.kind === "shutdown") this.terminate(result);
      if (result.kind === "escape") return this.dismissed(request);
      if (result.value !== otherValue) {
        return { kind: "completed", value: { type: "single", optionId: result.value } };
      }
      const otherText = await this.collectOtherText(field.label, request.dismissLabel, signal);
      if (otherText.kind === "dismissed") return this.dismissed(request);
      return { kind: "completed", value: { type: "single", otherText: otherText.text } };
    }

    const result = await this.tui.multiSelect({ ...presentation, items }, signal);
    if (result.kind === "abort" || result.kind === "shutdown") this.terminate(result);
    if (result.kind === "escape") return this.dismissed(request);
    if (field.required && result.values.length === 0) return this.dismissed(request);
    const wantsOther = otherValue !== undefined && result.values.includes(otherValue);
    const optionIds = result.values.filter((value) => value !== otherValue);
    if (!wantsOther) {
      return { kind: "completed", value: { type: "multiple", optionIds } };
    }
    const otherText = await this.collectOtherText(field.label, request.dismissLabel, signal);
    if (otherText.kind === "dismissed") return this.dismissed(request);
    return {
      kind: "completed",
      value: { type: "multiple", optionIds, otherText: otherText.text },
    };
  }

  private async collectOtherText(
    label: string,
    dismissLabel: string | undefined,
    signal: AbortSignal,
  ) {
    const result = await this.tui.textInput(
      {
        title: `${label} — Custom answer`,
        placeholder: "Type a custom answer and press Enter",
        dismissLabel,
        acceptsEmpty: false,
      },
      signal,
    );
    if (result.kind === "abort" || result.kind === "shutdown") this.terminate(result);
    if (result.kind === "escape") return { kind: "dismissed" as const };
    return { kind: "completed" as const, text: result.text };
  }

  private dismissed(
    request: InteractionRequest,
  ): Extract<InteractionResponse, { kind: "dismissed" }> {
    return this.validated(request, {
      requestId: request.requestId,
      kind: "dismissed",
      values: {},
    }) as Extract<InteractionResponse, { kind: "dismissed" }>;
  }

  private validated(request: InteractionRequest, response: InteractionResponse) {
    validateInteractionResponse(request, response);
    if (request.completionStatus) this.tui.setStatus(request.completionStatus);
    return response;
  }

  private fieldPresentation(
    request: InteractionRequest,
    field: InteractionField,
    first: boolean,
  ): Pick<CommandSelectionOptions, "title" | "detail" | "message" | "tone" | "dismissLabel"> {
    if (!first) {
      return {
        title: field.label,
        detail: field.description,
        dismissLabel: request.dismissLabel,
      };
    }
    const fieldDetail = [field.label, field.description].filter(Boolean).join("\n");
    return {
      title: request.title,
      detail: [request.detail, fieldDetail].filter(Boolean).join("\n\n") || undefined,
      message: request.message,
      tone: request.tone,
      dismissLabel: request.dismissLabel,
    };
  }

  private terminate(result: { readonly kind: "abort" | "shutdown"; readonly error: Error }): never {
    throw new InteractionAbortError(result.kind, result.error);
  }
}

function createInternalValue(existing: readonly string[]): string {
  const used = new Set(existing);
  let value = "__interaction_other__";
  while (used.has(value)) value += "_";
  return value;
}
