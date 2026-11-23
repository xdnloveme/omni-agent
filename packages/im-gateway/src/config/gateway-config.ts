export interface ManagedBotHostConfig {
  readonly mode: "managed";
}

export interface AttachedBotHostConfig {
  readonly mode: "attached";
  readonly port: number;
  readonly tokenEnv: string;
}

export type BotHostConfig = ManagedBotHostConfig | AttachedBotHostConfig;

export interface GatewayBotConfig {
  readonly id: string;
  readonly agentId: string;
  readonly projectDirectory: string;
  readonly stateDirectory: string;
  readonly allowUsers: readonly string[];
  readonly concurrency: "concurrent" | "serial";
  readonly lark: {
    readonly appId: string;
    readonly appSecretEnv: string;
    readonly verificationTokenEnv?: string;
    readonly encryptKeyEnv?: string;
  };
  readonly host: BotHostConfig;
}

export interface GatewayConfig {
  readonly version: 1;
  readonly stateFile: string;
  readonly bots: readonly GatewayBotConfig[];
}

export const gatewayConfigSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "stateFile", "bots"],
  properties: {
    version: { const: 1 },
    stateFile: { type: "string", minLength: 1 },
    bots: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "agentId",
          "projectDirectory",
          "stateDirectory",
          "allowUsers",
          "concurrency",
          "lark",
          "host",
        ],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._-]+$" },
          agentId: { type: "string", minLength: 1, maxLength: 128 },
          projectDirectory: { type: "string", minLength: 1 },
          stateDirectory: { type: "string", minLength: 1 },
          allowUsers: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
          concurrency: { enum: ["concurrent", "serial"] },
          lark: {
            type: "object",
            additionalProperties: false,
            required: ["appId", "appSecretEnv"],
            properties: {
              appId: { type: "string", minLength: 1 },
              appSecretEnv: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
              verificationTokenEnv: {
                type: "string",
                pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
                nullable: true,
              },
              encryptKeyEnv: {
                type: "string",
                pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
                nullable: true,
              },
            },
          },
          host: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["mode"],
                properties: {
                  mode: { const: "managed" },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["mode", "port", "tokenEnv"],
                properties: {
                  mode: { const: "attached" },
                  port: { type: "integer", minimum: 1, maximum: 65535 },
                  tokenEnv: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
                },
              },
            ],
          },
        },
      },
    },
  },
} as const;
