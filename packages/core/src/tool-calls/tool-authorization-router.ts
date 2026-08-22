import { createAuthorizedToolCall } from "../execution/authorized-tool-call";
import { assertJsonObject } from "../data";
import { throwIfAborted, type AuthorizedToolCall } from "../execution";
import type {
  PermissionControlledTool,
  PermissionGateResult,
} from "../permissions/permission-gate";
import type { PermissionGate } from "../permissions/permission-gate";
import type { PermissionContext } from "../permissions/types";
import type { RegisteredAgentTool } from "../types";
import type { ToolInputValidator } from "./tool-input-validator";

export interface ToolAuthorizationRequest {
  tool: RegisteredAgentTool;
  input: Record<string, unknown>;
  context: PermissionContext;
}

export type ToolAuthorizationResult =
  | PermissionGateResult
  | {
      outcome: "allowed";
      call: AuthorizedToolCall;
      authorizationMs: number;
      source: "trusted";
    };

export interface ToolAuthorizer {
  authorize(request: ToolAuthorizationRequest): Promise<ToolAuthorizationResult>;
}

export class ToolAuthorizationRouter implements ToolAuthorizer {
  constructor(
    private readonly permissionGate: PermissionGate,
    private readonly inputValidator: ToolInputValidator,
  ) {}

  async authorize(request: ToolAuthorizationRequest): Promise<ToolAuthorizationResult> {
    const startedAt = Date.now();
    throwIfAborted(request.context.signal);
    const preparedRequest = await this.prepareRequest(request);
    if (isPermissionControlled(preparedRequest.tool)) {
      const result = await this.permissionGate.authorize({
        ...preparedRequest,
        tool: preparedRequest.tool,
      });
      return { ...result, authorizationMs: Date.now() - startedAt };
    }

    const call = createAuthorizedToolCall(preparedRequest.tool, preparedRequest.input, {
      cwd: preparedRequest.context.cwd,
      signal: preparedRequest.context.signal,
    });
    throwIfAborted(preparedRequest.context.signal);
    return { outcome: "allowed", call, authorizationMs: Date.now() - startedAt, source: "trusted" };
  }

  private async prepareRequest(
    request: ToolAuthorizationRequest,
  ): Promise<ToolAuthorizationRequest> {
    const binder =
      request.tool.authorization.kind === "dynamic"
        ? request.tool.authorization.bindInput
        : undefined;
    if (!binder) return request;

    const input = await binder(structuredClone(request.input), request.context);
    assertJsonObject(input, `Dynamic authorization input for ${request.tool.name}`);
    const validationError = this.inputValidator.validate(request.tool.schema, input);
    if (validationError) {
      throw new Error(
        `Dynamic authorization input does not match the tool schema: ${validationError}`,
      );
    }
    throwIfAborted(request.context.signal);
    return { ...request, input };
  }
}

function isPermissionControlled(tool: RegisteredAgentTool): tool is PermissionControlledTool {
  return tool.authorization.kind !== "trusted";
}
