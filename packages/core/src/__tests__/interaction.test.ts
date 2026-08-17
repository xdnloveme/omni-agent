import { describe, expect, it } from "vitest";
import {
  InteractionError,
  RejectingInteractionSurface,
  validateInteractionRequest,
  validateInteractionResponse,
  type InteractionRequest,
} from "../index";

const request: InteractionRequest = {
  requestId: "request-1",
  title: "Clarification",
  fields: [
    {
      type: "single",
      id: "framework",
      label: "Framework",
      options: [{ id: "react", label: "React" }],
      allowOther: true,
    },
    { type: "text", id: "notes", label: "Notes" },
  ],
  completion: { type: "explicit", actions: [{ id: "submit", label: "Submit" }] },
};

describe("interaction contract", () => {
  it("accepts a structurally valid request and response", () => {
    expect(() => validateInteractionRequest(request)).not.toThrow();
    expect(() =>
      validateInteractionResponse(request, {
        requestId: request.requestId,
        kind: "completed",
        actionId: "submit",
        values: {
          framework: { type: "single", optionId: "react" },
          notes: { type: "text", text: "Keep the API" },
        },
      }),
    ).not.toThrow();
  });

  it("rejects duplicate field and option ids", () => {
    expect(() =>
      validateInteractionRequest({ ...request, fields: [request.fields[0]!, request.fields[0]!] }),
    ).toThrowError(expect.objectContaining({ code: "invalid_interaction_request" }));
    expect(() =>
      validateInteractionRequest({
        ...request,
        fields: [
          {
            type: "single",
            id: "framework",
            label: "Framework",
            options: [
              { id: "react", label: "React" },
              { id: "react", label: "React again" },
            ],
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_interaction_request" }));
  });

  it("rejects mismatched responses and undeclared values", () => {
    expect(() =>
      validateInteractionResponse(request, {
        requestId: "wrong",
        kind: "dismissed",
        values: {},
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_interaction_response" }));
    expect(() =>
      validateInteractionResponse(request, {
        requestId: request.requestId,
        kind: "completed",
        actionId: "submit",
        values: { framework: { type: "single", optionId: "vue" } },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_interaction_response" }));
  });

  it("rejects interaction on a non-interactive host", async () => {
    await expect(new RejectingInteractionSurface().request(request)).rejects.toEqual(
      expect.objectContaining<Partial<InteractionError>>({ code: "interaction_unavailable" }),
    );
  });
});
