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
    expect(() =>
      validateInteractionRequest({
        ...request,
        completion: { type: "explicit", actions: [] },
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

  it("accepts action-free completion with answered required fields and omitted optional fields", () => {
    const onComplete: InteractionRequest = {
      ...request,
      fields: [{ ...request.fields[0]!, required: true }, request.fields[1]!],
      completion: { type: "on_complete" },
    };
    expect(() =>
      validateInteractionResponse(onComplete, {
        requestId: request.requestId,
        kind: "completed",
        values: { framework: { type: "single", otherText: "SolidJS" } },
      }),
    ).not.toThrow();
    expect(() =>
      validateInteractionResponse(onComplete, {
        requestId: request.requestId,
        kind: "completed",
        values: {},
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_interaction_response" }));
  });

  it("enforces generic required and selection invariants", () => {
    const constrained: InteractionRequest = {
      requestId: "constrained",
      title: "Input",
      fields: [
        {
          type: "single",
          id: "choice",
          label: "Choice",
          options: [{ id: "a", label: "A" }],
          allowOther: true,
          required: true,
        },
        {
          type: "multiple",
          id: "features",
          label: "Features",
          options: [{ id: "search", label: "Search" }],
          required: true,
        },
        { type: "text", id: "notes", label: "Notes", required: true },
      ],
      completion: { type: "on_complete" },
    };
    const invalidValues = [
      {
        choice: { type: "single" as const },
        features: { type: "multiple" as const, optionIds: ["search"] },
        notes: { type: "text" as const, text: "Ready" },
      },
      {
        choice: { type: "single" as const, optionId: "a", otherText: "Custom" },
        features: { type: "multiple" as const, optionIds: ["search"] },
        notes: { type: "text" as const, text: "Ready" },
      },
      {
        choice: { type: "single" as const, optionId: "a" },
        features: { type: "multiple" as const, optionIds: [] },
        notes: { type: "text" as const, text: "Ready" },
      },
      {
        choice: { type: "single" as const, optionId: "a" },
        features: { type: "multiple" as const, optionIds: ["search"] },
        notes: { type: "text" as const, text: "   " },
      },
    ];

    for (const values of invalidValues) {
      expect(() =>
        validateInteractionResponse(constrained, {
          requestId: constrained.requestId,
          kind: "completed",
          values,
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_interaction_response" }));
    }
  });

  it("rejects malformed runtime responses with structured interaction errors", () => {
    for (const response of [
      null,
      { requestId: request.requestId, kind: "completed", values: null },
      {
        requestId: request.requestId,
        kind: "completed",
        actionId: "submit",
        values: { framework: null },
      },
    ]) {
      expect(() => validateInteractionResponse(request, response as never)).toThrowError(
        expect.objectContaining({ code: "invalid_interaction_response" }),
      );
    }
  });

  it("rejects interaction on a non-interactive host", async () => {
    await expect(new RejectingInteractionSurface().request(request)).rejects.toEqual(
      expect.objectContaining<Partial<InteractionError>>({ code: "interaction_unavailable" }),
    );
  });
});
