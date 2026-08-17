import { InteractionError } from "./errors";
import type {
  InteractionAction,
  InteractionField,
  InteractionRequest,
  InteractionResponse,
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
  } else if (request.completion.type === "explicit") {
    requireUnique(request.completion.actions, "action");
    for (const action of request.completion.actions) {
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
  if (response.requestId !== request.requestId) {
    invalidResponse("Response requestId does not match the request");
  }
  if (response.kind === "dismissed") {
    if (Object.keys(response.values).length > 0) {
      invalidResponse("A dismissed response cannot contain values");
    }
    return;
  }
  if (response.kind !== "completed") invalidResponse("Unsupported response kind");

  const fields = new Map(request.fields.map((field) => [field.id, field]));
  for (const [fieldId, value] of Object.entries(response.values)) {
    const field = fields.get(fieldId);
    if (!field) invalidResponse(`Response contains an unknown field: ${fieldId}`);
    if (field!.type !== value.type) {
      invalidResponse(`Response type does not match field ${fieldId}`);
    }
    if (field!.type === "single" && value.type === "single") {
      validateSelectValue(field!, value.optionId, value.otherText);
    } else if (field!.type === "multiple" && value.type === "multiple") {
      if (new Set(value.optionIds).size !== value.optionIds.length) {
        invalidResponse(`Response contains duplicate options for field ${fieldId}`);
      }
      for (const optionId of value.optionIds) validateSelectValue(field!, optionId, undefined);
      if (value.otherText !== undefined && !field!.allowOther) {
        invalidResponse(`Field ${fieldId} does not allow other text`);
      }
    }
  }

  if (request.completion.type === "explicit") {
    validateAction(request.completion.actions, response.actionId);
  } else {
    if (response.actionId !== undefined)
      invalidResponse("on_select response cannot contain actionId");
    if (!(request.completion.fieldId in response.values)) {
      invalidResponse("on_select response must contain its completion field");
    }
  }
}

function validateAction(actions: readonly InteractionAction[], actionId: string | undefined): void {
  if (!actionId || !actions.some((action) => action.id === actionId)) {
    invalidResponse("Completed explicit interaction must contain a declared actionId");
  }
}

function validateSelectValue(
  field: Extract<InteractionField, { type: "single" | "multiple" }>,
  optionId: string | undefined,
  otherText: string | undefined,
): void {
  if (optionId !== undefined && !field.options.some((option) => option.id === optionId)) {
    invalidResponse(`Unknown option ${optionId} for field ${field.id}`);
  }
  if (otherText !== undefined && !field.allowOther) {
    invalidResponse(`Field ${field.id} does not allow other text`);
  }
}

function requireUnique(values: readonly { readonly id: string }[], label: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) invalidRequest(`Duplicate ${label} id: ${value.id}`);
    ids.add(value.id);
  }
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
