const AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_ORIGIN_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function isAgentId(value: string): boolean {
  return AGENT_ID.test(value);
}

export function isToolOriginId(value: string): boolean {
  return TOOL_ORIGIN_ID.test(value);
}
