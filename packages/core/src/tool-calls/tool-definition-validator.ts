import type { AgentToolDefinition } from "../types";
import { ToolInputValidator } from "./tool-input-validator";

const TOOL_NAME = /^[a-z][a-z0-9_-]*$/;
const MAX_TIMER_MS = 2_147_483_647;

export class ToolDefinitionValidator {
  constructor(private readonly inputValidator = new ToolInputValidator()) {}

  validate(tool: AgentToolDefinition): void {
    if (!tool || typeof tool !== "object") throw new Error("Tool definition is required");
    if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) {
      throw new Error(`Invalid tool name: ${String(tool.name)}`);
    }
    if (typeof tool.description !== "string" || !tool.description.trim()) {
      throw new Error(`Tool description is required: ${tool.name}`);
    }
    if (!tool.schema || typeof tool.schema !== "object" || Array.isArray(tool.schema)) {
      throw new Error(`Tool schema is required: ${tool.name}`);
    }
    this.inputValidator.assertValidSchema(tool.schema);
    if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
      throw new Error(`Invalid strict schema setting: ${tool.name}`);
    }
    if (
      tool.preflight !== undefined &&
      (!tool.preflight ||
        typeof tool.preflight !== "object" ||
        typeof tool.preflight.validate !== "function")
    ) {
      throw new Error(`Invalid tool preflight: ${tool.name}`);
    }
    validateTimeout(tool);
    validateAuthorization(tool);
    validateExecution(tool);
    if (typeof tool.execute !== "function")
      throw new Error(`Tool execute is required: ${tool.name}`);
  }
}

function validateTimeout(tool: AgentToolDefinition): void {
  const timeout = tool.timeout;
  if (!timeout || typeof timeout !== "object") {
    throw new Error(`Tool timeout policy is required: ${tool.name}`);
  }
  if (timeout.kind === "none") return;
  if (timeout.kind === "fixed") {
    if (
      !Number.isInteger(timeout.timeoutMs) ||
      timeout.timeoutMs <= 0 ||
      timeout.timeoutMs > MAX_TIMER_MS
    ) {
      throw new Error(`Invalid fixed tool timeout: ${tool.name}`);
    }
    return;
  }
  if (timeout.kind !== "input") {
    throw new Error(`Invalid tool timeout policy: ${tool.name}`);
  }
  if (
    !timeout.parameter ||
    !Number.isInteger(timeout.defaultMs) ||
    !Number.isInteger(timeout.minMs) ||
    !Number.isInteger(timeout.maxMs) ||
    timeout.minMs <= 0 ||
    timeout.minMs > timeout.defaultMs ||
    timeout.defaultMs > timeout.maxMs ||
    timeout.maxMs > MAX_TIMER_MS
  ) {
    throw new Error(`Invalid input tool timeout: ${tool.name}`);
  }
  const properties = tool.schema.properties;
  const property =
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? (properties as Record<string, unknown>)[timeout.parameter]
      : undefined;
  if (!property || typeof property !== "object" || Array.isArray(property)) {
    throw new Error(`Timeout schema property is missing: ${tool.name}.${timeout.parameter}`);
  }
  const schema = property as Record<string, unknown>;
  if (
    schema.type !== "integer" ||
    schema.minimum !== timeout.minMs ||
    schema.maximum !== timeout.maxMs
  ) {
    throw new Error(`Timeout policy does not match schema: ${tool.name}.${timeout.parameter}`);
  }
}

function validateAuthorization(tool: AgentToolDefinition): void {
  const descriptor = tool.authorization;
  if (!descriptor || typeof descriptor !== "object") {
    throw new Error(`Tool authorization descriptor is required: ${tool.name}`);
  }
  if (descriptor.kind === "trusted") {
    if (typeof descriptor.reason !== "string" || !descriptor.reason.trim()) {
      throw new Error(`Trusted authorization reason is required: ${tool.name}`);
    }
  } else if (descriptor.kind === "static") {
    if (descriptor.risk !== "read" && descriptor.risk !== "execute") {
      throw new Error(`Invalid static permission risk: ${tool.name}`);
    }
    if (typeof descriptor.reason !== "string" || !descriptor.reason.trim()) {
      throw new Error(`Static permission reason is required: ${tool.name}`);
    }
  } else if (descriptor.kind === "dynamic") {
    if (typeof descriptor.assess !== "function") {
      throw new Error(`Dynamic permission assessor is required: ${tool.name}`);
    }
  } else {
    throw new Error(`Invalid authorization descriptor: ${tool.name}`);
  }
  if (
    descriptor.hiddenInputKeys !== undefined &&
    (!Array.isArray(descriptor.hiddenInputKeys) ||
      descriptor.hiddenInputKeys.some((key) => typeof key !== "string" || !key))
  ) {
    throw new Error(`Invalid hidden authorization fields: ${tool.name}`);
  }
}

function validateExecution(tool: AgentToolDefinition): void {
  const strategy = tool.execution;
  if (!strategy || typeof strategy !== "object") {
    throw new Error(`Tool execution strategy is required: ${tool.name}`);
  }
  if (strategy.kind === "host") return;
  if (
    strategy.kind !== "sandbox_eligible" ||
    typeof strategy.profile !== "string" ||
    !strategy.profile.trim()
  ) {
    throw new Error(`Invalid tool execution strategy: ${tool.name}`);
  }
}
