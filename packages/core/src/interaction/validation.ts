import { InteractionError } from "./errors";
import type {
  InteractionAction,
  InteractionField,
  InteractionRequest,
  InteractionResponse,
  InteractionValue,
} from "./types";

export function validateInteractionRequest(request: InteractionRequest): void {
  requireText(request.requestId, "requestId");
  requireText(request.title, "title");
  if (request.dismissLabel !== undefined) requireText(request.dismissLabel, "dismissLabel");
  if (request.status !== undefined) requireText(request.status, "status");
  if (request.completionStatus !== undefined)
    requireText(request.completionStatus, "completionStatus");
  requireUnique(request.fields, "field");

  for (const field of request.fields) {
    requireText(field.id, "field.id");
    requireText(field.label, `field ${field.id} label`);
    if (field.type === "single" || field.type === "multiple") {
      requireUnique(field.options, `option in field ${field.id}`);
      for (const option of field.options) {
        requireText(option.id, `option id in field ${field.id}`);
        requireText(option.label, `option ${option.id} label`);
      }
    } else if (field.type !== "text") {
      invalidRequest(`Unsupported field type: ${String((field as { type?: unknown }).type)}`);
    }
  }

  const completion = request.completion;
  if (completion.type === "on_select") {
    const field = request.fields.find((candidate) => candidate.id === completion.fieldId);
    if (!field) invalidRequest(`Completion field does not exist: ${completion.fieldId}`);
    if (field?.type !== "single") {
      invalidRequest("on_select completion requires a single-select field");
    }
  } else if (completion.type === "on_complete") {
    if (request.fields.length === 0) {
      invalidRequest("on_complete requires at least one field");
    }
  } else if (completion.type === "explicit") {
    if (completion.actions.length === 0) {
      invalidRequest("explicit completion requires at least one action");
    }
    requireUnique(completion.actions, "action");
    for (const action of completion.actions) {
      requireText(action.id, "action.id");
      requireText(action.label, `action ${action.id} label`);
    }
  } else {
    invalidRequest("Unsupported completion type");
  }
}

export function validateInteractionResponse(
  request: InteractionRequest,
  response: InteractionResponse,
): void {
  if (!isRecord(response)) invalidResponse("Response must be an object");
  if (!isRecord(response.values)) invalidResponse("Response values must be an object");
  if (response.requestId !== request.requestId) {
    invalidResponse("Response requestId does not match the request");
  }
  if (response.kind === "dismissed") {
    if ("actionId" in response) {
      invalidResponse("A dismissed response cannot contain actionId");
    }
    if (Object.keys(response.values).length > 0) {
      invalidResponse("A dismissed response cannot contain values");
    }
    return;
  }
  if (response.kind !== "completed") invalidResponse("Unsupported response kind");

  const fields = new Map(request.fields.map((field) => [field.id, field]));
  for (const [fieldId, candidate] of Object.entries(response.values)) {
    if (!isRecord(candidate) || typeof candidate.type !== "string") {
      invalidResponse(`Response contains an invalid value for field ${fieldId}`);
    }
    const value = candidate as unknown as InteractionValue;
    const field = fields.get(fieldId);
    if (!field) invalidResponse(`Response contains an unknown field: ${fieldId}`);
    if (field!.type !== value.type) {
      invalidResponse(`Response type does not match field ${fieldId}`);
    }
    validateFieldValue(field!, value);
  }

  for (const field of request.fields) {
    if (field.required && !isAnswered(field, response.values[field.id])) {
      invalidResponse(`Required field was not answered: ${field.id}`);
    }
  }

  if (request.completion.type === "explicit") {
    validateAction(request.completion.actions, response.actionId);
  } else if (request.completion.type === "on_select") {
    if (response.actionId !== undefined)
      invalidResponse("on_select response cannot contain actionId");
    const field = fields.get(request.completion.fieldId)!;
    if (!isAnswered(field, response.values[field.id])) {
      invalidResponse("on_select response must contain its completion field");
    }
  } else {
    if (response.actionId !== undefined)
      invalidResponse("on_complete response cannot contain actionId");
  }
}

function validateAction(actions: readonly InteractionAction[], actionId: string | undefined): void {
  if (!actionId || !actions.some((action) => action.id === actionId)) {
    invalidResponse("Completed explicit interaction must contain a declared actionId");
  }
}

function validateFieldValue(field: InteractionField, value: InteractionValue): void {
  if (field.type === "text" && value.type === "text") {
    if (typeof value.text !== "string") invalidResponse(`Field ${field.id} must contain text`);
    return;
  }
  if (field.type === "single" && value.type === "single") {
    if (value.optionId !== undefined && value.otherText !== undefined) {
      invalidResponse(`Single-select field ${field.id} cannot contain an option and other text`);
    }
    validateOption(field, value.optionId);
    validateOtherText(field, value.otherText);
    return;
  }
  if (field.type === "multiple" && value.type === "multiple") {
    if (!Array.isArray(value.optionIds)) {
      invalidResponse(`Multiple-select field ${field.id} must contain optionIds`);
    }
    if (new Set(value.optionIds).size !== value.optionIds.length) {
      invalidResponse(`Response contains duplicate options for field ${field.id}`);
    }
    for (const optionId of value.optionIds) validateOption(field, optionId);
    validateOtherText(field, value.otherText);
  }
}

function validateOption(
  field: Extract<InteractionField, { type: "single" | "multiple" }>,
  optionId: string | undefined,
): void {
  if (optionId !== undefined && !field.options.some((option) => option.id === optionId)) {
    invalidResponse(`Unknown option ${optionId} for field ${field.id}`);
  }
}

function validateOtherText(
  field: Extract<InteractionField, { type: "single" | "multiple" }>,
  otherText: string | undefined,
): void {
  if (otherText === undefined) return;
  if (!field.allowOther) invalidResponse(`Field ${field.id} does not allow other text`);
  if (typeof otherText !== "string" || !otherText.trim()) {
    invalidResponse(`Other text for field ${field.id} must not be blank`);
  }
}

function isAnswered(field: InteractionField, value: InteractionValue | undefined): boolean {
  if (!value || field.type !== value.type) return false;
  if (field.type === "text" && value.type === "text") return Boolean(value.text.trim());
  if (field.type === "single" && value.type === "single") {
    return value.optionId !== undefined || Boolean(value.otherText?.trim());
  }
  if (field.type === "multiple" && value.type === "multiple") {
    return value.optionIds.length > 0 || Boolean(value.otherText?.trim());
  }
  return false;
}

function requireUnique(values: readonly { readonly id: string }[], label: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) invalidRequest(`Duplicate ${label} id: ${value.id}`);
    ids.add(value.id);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: string, label: string): void {
  if (!value.trim()) invalidRequest(`${label} must not be blank`);
}

function invalidRequest(message: string): never {
  throw new InteractionError("invalid_interaction_request", message);
}

function invalidResponse(message: string): never {
  throw new InteractionError("invalid_interaction_response", message);
}
