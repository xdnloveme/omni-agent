export type UserInputQuestion =
  | {
      readonly id: string;
      readonly question: string;
      readonly description?: string;
      readonly type: "single" | "multiple";
      readonly options: readonly UserInputOption[];
      readonly required?: boolean;
      readonly allowOther?: boolean;
    }
  | {
      readonly id: string;
      readonly question: string;
      readonly description?: string;
      readonly type: "text";
      readonly placeholder?: string;
      readonly required?: boolean;
    };

export interface UserInputOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface RequestUserInputArgs {
  readonly context?: string;
  readonly questions: readonly UserInputQuestion[];
}

export type UserInputErrorCode = "invalid_user_input_request" | "invalid_user_input_response";
