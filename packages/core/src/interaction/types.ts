export type InteractionTone = "default" | "warning" | "danger";
export type InteractionItemTone = "default" | "positive" | "negative";

export interface InteractionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly tone?: InteractionItemTone;
}

interface InteractionFieldBase {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly required?: boolean;
}

export interface InteractionSingleSelectField extends InteractionFieldBase {
  readonly type: "single";
  readonly options: readonly InteractionOption[];
  readonly allowOther?: boolean;
}

export interface InteractionMultiSelectField extends InteractionFieldBase {
  readonly type: "multiple";
  readonly options: readonly InteractionOption[];
  readonly allowOther?: boolean;
}

export interface InteractionTextField extends InteractionFieldBase {
  readonly type: "text";
  readonly placeholder?: string;
}

export type InteractionField =
  InteractionSingleSelectField | InteractionMultiSelectField | InteractionTextField;

export interface InteractionAction {
  readonly id: string;
  readonly label: string;
  readonly tone?: InteractionItemTone;
}

export type InteractionCompletion =
  | { readonly type: "on_select"; readonly fieldId: string }
  | { readonly type: "on_complete" }
  | { readonly type: "explicit"; readonly actions: readonly InteractionAction[] };

export interface InteractionRequest {
  readonly requestId: string;
  readonly title: string;
  readonly detail?: string;
  readonly message?: string;
  readonly tone?: InteractionTone;
  readonly dismissLabel?: string;
  readonly status?: string;
  readonly completionStatus?: string;
  readonly fields: readonly InteractionField[];
  readonly completion: InteractionCompletion;
}

export type InteractionValue =
  | { readonly type: "single"; readonly optionId?: string; readonly otherText?: string }
  | {
      readonly type: "multiple";
      readonly optionIds: readonly string[];
      readonly otherText?: string;
    }
  | { readonly type: "text"; readonly text: string };

export type InteractionResponse =
  | {
      readonly requestId: string;
      readonly kind: "completed";
      readonly actionId?: string;
      readonly values: Readonly<Record<string, InteractionValue>>;
    }
  | {
      readonly requestId: string;
      readonly kind: "dismissed";
      readonly values: Readonly<Record<string, never>>;
    };
