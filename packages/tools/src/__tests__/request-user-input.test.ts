import { describe, expect, it, vi } from "vitest";
import { InteractionError, type InteractionRequest } from "@omni-agent/core";
import { ScriptedInteractionSurface } from "@omni-agent/core/testing";
import { createRequestUserInputTool } from "../user-input/request-user-input";
import { validateRequestUserInputArgs } from "../user-input/request-user-input-preflight";

describe("request_user_input", () => {
  it("rejects duplicate ids and invalid text-question fields before presentation", () => {
    expect(() =>
      validateRequestUserInputArgs({
        questions: [
          { id: "same", question: "First", type: "text" },
          { id: "same", question: "Second", type: "text" },
        ],
      }),
    ).toThrow("Duplicate question id");
    expect(() =>
      validateRequestUserInputArgs({
        questions: [
          {
            id: "notes",
            question: "Notes",
            type: "text",
            options: [],
          } as never,
        ],
      }),
    ).toThrow("cannot declare options");
  });

  it("maps single, multiple, text, Other and submitted metadata", async () => {
    let captured: InteractionRequest | undefined;
    const surface = new ScriptedInteractionSurface();
    surface.enqueue((request) => {
      captured = request;
      return {
        requestId: request.requestId,
        kind: "completed",
        actionId: "submit",
        values: {
          framework: { type: "single", optionId: "react" },
          features: { type: "multiple", optionIds: ["search"], otherText: "Export" },
          notes: { type: "text", text: "Preserve the API" },
        },
      };
    });
    const result = await createRequestUserInputTool(surface).execute(
      {
        context: "Choose implementation constraints",
        questions: [
          {
            id: "framework",
            question: "Framework",
            type: "single",
            options: [
              { id: "react", label: "React" },
              { id: "vue", label: "Vue" },
            ],
          },
          {
            id: "features",
            question: "Features",
            type: "multiple",
            allowOther: true,
            options: [
              { id: "search", label: "Search" },
              { id: "filter", label: "Filter" },
            ],
          },
          { id: "notes", question: "Notes", type: "text" },
        ],
      },
      { cwd: process.cwd() },
    );

    expect(captured?.fields.map((field) => field.type)).toEqual(["single", "multiple", "text"]);
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("[framework] Framework: React");
    expect(result.content[0]?.text).toContain("Search, Export");
    expect(result.meta?.interaction).toMatchObject({ outcome: "submitted" });
  });

  it("treats Skip and dismiss as successful clarification outcomes", async () => {
    for (const kind of ["skip", "dismissed"] as const) {
      const surface = new ScriptedInteractionSurface();
      surface.enqueue((request) =>
        kind === "dismissed"
          ? { requestId: request.requestId, kind: "dismissed", values: {} }
          : {
              requestId: request.requestId,
              kind: "completed",
              actionId: "skip",
              values: {},
            },
      );
      const result = await createRequestUserInputTool(surface).execute(
        {
          questions: [
            {
              id: "choice",
              question: "Choice",
              type: "single",
              options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
              ],
            },
          ],
        },
        { cwd: process.cwd() },
      );
      expect(result).toMatchObject({
        isError: false,
        meta: { interaction: { outcome: "skipped" } },
      });
    }
  });

  it("returns structured errors for unavailable and invalid responses but propagates Abort", async () => {
    const unavailable = createRequestUserInputTool({
      request: vi.fn(async () => {
        throw new InteractionError("interaction_unavailable", "unavailable");
      }),
    });
    const args = {
      questions: [
        {
          id: "choice",
          question: "Choice",
          type: "single" as const,
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      ],
    };
    expect(await unavailable.execute(args, { cwd: process.cwd() })).toMatchObject({
      isError: true,
      meta: { code: "interaction_unavailable" },
    });

    const invalidSurfaceResponse = createRequestUserInputTool({
      request: vi.fn(async () => ({
        requestId: "wrong-request",
        kind: "dismissed" as const,
        values: {},
      })),
    });
    expect(await invalidSurfaceResponse.execute(args, { cwd: process.cwd() })).toMatchObject({
      isError: true,
      meta: { code: "invalid_interaction_response" },
    });

    const invalidBusinessResponse = createRequestUserInputTool({
      request: vi.fn(async (request: InteractionRequest) => ({
        requestId: request.requestId,
        kind: "completed" as const,
        actionId: "submit",
        values: {},
      })),
    });
    expect(await invalidBusinessResponse.execute(args, { cwd: process.cwd() })).toMatchObject({
      isError: true,
      meta: { code: "invalid_user_input_response" },
    });

    const aborted = createRequestUserInputTool({
      request: vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    });
    await expect(aborted.execute(args, { cwd: process.cwd() })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
