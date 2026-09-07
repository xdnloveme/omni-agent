const requestId = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9._:-]+$",
} as const;

const agentId = { type: "string", minLength: 1, maxLength: 128 } as const;
const sessionId = { type: "string", minLength: 1, maxLength: 256 } as const;

export const agentHostHelloSchema = {
  type: "object",
  additionalProperties: false,
  required: ["v", "type", "token"],
  properties: {
    v: { const: 2 },
    type: { const: "hello" },
    token: {
      type: "string",
      minLength: 43,
      maxLength: 43,
      pattern: "^[A-Za-z0-9_-]{43}$",
    },
  },
} as const;

export const agentHostRequestSchema = {
  oneOf: [
    operation("list_agents", {}),
    operation("open_session", { agentId, sessionId }, ["agentId"]),
    operation("create_session", { agentId }, ["agentId"]),
    operation("close_session", { agentId, sessionId }, ["agentId", "sessionId"]),
    operation(
      "run",
      {
        agentId,
        sessionId,
        text: { type: "string", minLength: 1, maxLength: 32_768 },
      },
      ["agentId", "sessionId", "text"],
    ),
    operation("cancel", { requestId }, ["requestId"]),
    operation(
      "resolve_permission",
      { permissionId: requestId, decision: { enum: ["approve", "deny"] } },
      ["permissionId", "decision"],
    ),
  ],
} as const;

function operation(
  type: string,
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["v", "id", "type", ...required],
    properties: {
      v: { const: 2 },
      id: requestId,
      type: { const: type },
      ...properties,
    },
  };
}
