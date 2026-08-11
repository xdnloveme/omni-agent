import { createAuthorizedToolCall } from "../execution/authorized-tool-call";
import { throwIfAborted, type AuthorizedToolCall } from "../execution";
import type {
  PermissionControlledTool,
  PermissionGateResult,
} from "../permissions/permission-gate";
import type { PermissionGate } from "../permissions/permission-gate";
import type { PermissionContext } from "../permissions/types";
import type { RegisteredAgentTool } from "../types";

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
  constructor(private readonly permissionGate: PermissionGate) {}

  async authorize(request: ToolAuthorizationRequest): Promise<ToolAuthorizationResult> {
    if (isPermissionControlled(request.tool)) {
      return this.permissionGate.authorize({ ...request, tool: request.tool });
    }

    const startedAt = Date.now();
    throwIfAborted(request.context.signal);
    const call = createAuthorizedToolCall(request.tool, request.input, {
      cwd: request.context.cwd,
      signal: request.context.signal,
    });
    throwIfAborted(request.context.signal);
    return { outcome: "allowed", call, authorizationMs: Date.now() - startedAt, source: "trusted" };
  }
}

function isPermissionControlled(tool: RegisteredAgentTool): tool is PermissionControlledTool {
  return tool.authorization.kind !== "trusted";
}
