const requestId = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9._:-]+$",
} as const;

const agentId = { type: "string", minLength: 1, maxLength: 128 } as const;
const sessionId = { type: "string", minLength: 1, maxLength: 256 } as const;
const failure = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "retryable"],
  properties: {
    code: { type: "string", minLength: 1 },
    message: { type: "string" },
    retryable: { type: "boolean" },
  },
} as const;
const session = {
  type: "object",
  additionalProperties: false,
  required: ["agentId", "sessionId"],
  properties: { agentId, sessionId },
} as const;
const agent = {
  type: "object",
  additionalProperties: false,
  required: ["id", "displayName", "description", "packageName", "packageVersion"],
  properties: {
    id: agentId,
    displayName: { type: "string" },
    description: { type: "string" },
    packageName: { type: "string", minLength: 1 },
    packageVersion: { type: "string", minLength: 1 },
  },
} as const;

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

export const agentHostServerMessageSchema = {
  oneOf: [
    strictObject(
      {
        v: { const: 2 },
        type: { const: "ready" },
        connectionId: { type: "string", minLength: 1 },
      },
      ["v", "type", "connectionId"],
    ),
    result({
      type: "object",
      additionalProperties: false,
      required: ["kind", "agents"],
      properties: {
        kind: { const: "agents" },
        agents: { type: "array", items: agent },
      },
    }),
    result({
      type: "object",
      additionalProperties: false,
      required: ["kind", "session"],
      properties: {
        kind: { const: "session" },
        session,
      },
    }),
    result({
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { const: "closed" } },
    }),
    result({
      type: "object",
      additionalProperties: false,
      required: ["kind", "requestId"],
      properties: {
        kind: { const: "cancel_requested" },
        requestId,
      },
    }),
    result({
      type: "object",
      additionalProperties: false,
      required: ["kind", "permissionId"],
      properties: {
        kind: { const: "permission_resolved" },
        permissionId: requestId,
      },
    }),
    event(
      strictObject(
        {
          type: { const: "started" },
          requestId,
          sessionId,
        },
        ["type", "requestId", "sessionId"],
      ),
    ),
    event(
      strictObject(
        {
          type: { const: "text_delta" },
          text: { type: "string" },
        },
        ["type", "text"],
      ),
    ),
    event(
      strictObject(
        {
          type: { const: "final_response" },
          text: { type: "string" },
        },
        ["type", "text"],
      ),
    ),
    event(strictObject({ type: { const: "completed" } }, ["type"])),
    event({
      ...failure,
      properties: {
        ...failure.properties,
        type: { const: "failed" },
      },
      required: ["type", ...failure.required],
    }),
    event(strictObject({ type: { const: "cancelled" } }, ["type"])),
    strictObject(
      {
        v: { const: 2 },
        type: { const: "permission.requested" },
        requestId,
        permissionId: requestId,
        expiresAt: { type: "number" },
        presentation: strictObject(
          {
            title: { type: "string" },
            resources: { type: "array", items: { type: "string" } },
          },
          ["title", "resources"],
        ),
      },
      ["v", "type", "requestId", "permissionId", "expiresAt", "presentation"],
    ),
    strictObject(
      {
        v: { const: 2 },
        type: { const: "permission.resolved" },
        requestId,
        permissionId: requestId,
        decision: { enum: ["approve", "deny"] },
        reason: { enum: ["user", "expired", "cancelled", "disconnected"] },
      },
      ["v", "type", "requestId", "permissionId", "decision", "reason"],
    ),
    strictObject(
      {
        v: { const: 2 },
        type: { const: "error" },
        id: requestId,
        error: failure,
      },
      ["v", "type", "error"],
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

function result(resultSchema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return strictObject(
    {
      v: { const: 2 },
      type: { const: "result" },
      id: requestId,
      result: resultSchema,
    },
    ["v", "type", "id", "result"],
  );
}

function event(eventSchema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return strictObject(
    {
      v: { const: 2 },
      type: { const: "event" },
      requestId,
      event: eventSchema,
    },
    ["v", "type", "requestId", "event"],
  );
}

function strictObject(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}
