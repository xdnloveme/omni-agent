import { describe, expect, it, vi } from "vitest";
import { InteractionError, isInProcessTool, type InteractionRequest } from "@omni-agent/core";
import { ScriptedInteractionSurface } from "@omni-agent/core/testing";
import { createRequestUserInputTool } from "../user-input/request-user-input";
import { validateRequestUserInputArgs } from "../user-input/request-user-input-preflight";

function inputTool(surface: Parameters<typeof createRequestUserInputTool>[0]) {
  const tool = createRequestUserInputTool(surface);
  if (!isInProcessTool(tool)) throw new Error("Expected in-process input tool");
  return tool;
}

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
        values: {
          framework: { type: "single", optionId: "react" },
          features: { type: "multiple", optionIds: ["search"], otherText: "Export" },
          notes: { type: "text", text: "Preserve the API" },
        },
      };
    });
    const result = await inputTool(surface).execute(
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
    expect(captured?.title).toBe("Input requested");
    expect(captured?.completion).toEqual({ type: "on_complete" });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("User input responses:");
    expect(result.content[0]?.text).toContain("[framework] Framework: React");
    expect(result.content[0]?.text).toContain("Search, Export");
    expect(result.meta?.interaction).toMatchObject({ outcome: "submitted" });
  });

  it("treats Escape as a successful skipped input outcome", async () => {
    const surface = new ScriptedInteractionSurface();
    surface.enqueue((request) => ({
      requestId: request.requestId,
      kind: "dismissed",
      values: {},
    }));
    const result = await inputTool(surface).execute(
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
      content: [{ type: "text", text: "The user skipped this input request." }],
      meta: { interaction: { outcome: "skipped" } },
    });
  });

  it("structures interaction errors but propagates Abort and unexpected failures", async () => {
    const unavailable = inputTool({
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

    const invalidSurfaceResponse = inputTool({
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

    const invalidInteractionResponse = inputTool({
      request: vi.fn(async (request: InteractionRequest) => ({
        requestId: request.requestId,
        kind: "completed" as const,
        values: { choice: { type: "single" as const } },
      })),
    });
    expect(await invalidInteractionResponse.execute(args, { cwd: process.cwd() })).toMatchObject({
      isError: true,
      meta: { code: "invalid_interaction_response" },
    });

    const aborted = inputTool({
      request: vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    });
    await expect(aborted.execute(args, { cwd: process.cwd() })).rejects.toMatchObject({
      name: "AbortError",
    });

    const failed = inputTool({
      request: vi.fn(async () => {
        throw new Error("surface failed");
      }),
    });
    await expect(failed.execute(args, { cwd: process.cwd() })).rejects.toThrow("surface failed");
  });
});
