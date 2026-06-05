export { runAgentLoop } from "./agent-loop.js";
export type { AgentLoopOptions } from "./agent-loop.js";
export { toContextMessages } from "./llm-context.js";
export { loadConfig, saveConfig, getConfigDir, getConfigPath, type OmniConfig } from "./config.js";
export { getApiKey, saveApiKey, deleteApiKey } from "./credential.js";
export type { AgentConfig, AgentTool, AgentEvent, ToolResult, Message, TokenUsage } from "./types.js";
export { buildModel, getDefaultContextWindow } from "./llm.js";
export { CommandRegistry } from "./commands/index.js";
export type { Command, CommandContext, CommandTui } from "./commands/index.js";
export { buildSystemPrompt, composeSystemPrompt, BASE_SYSTEM_PROMPT } from "./system-prompt/index.js";
export type { SystemPromptContributor } from "./system-prompt/index.js";
export { StreamSession, createStreamSession } from "./stream/index.js";
export type {
  StreamEvent,
  StreamCallbacks,
  StreamState,
  AccumulatedMessage,
  ToolResultPayload,
} from "./stream/index.js";
export {
  SessionManager,
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
  readIndex,
  replayMessages,
  clearSession,
} from "./session/index.js";
export type { SessionMessage, SessionEntry, SessionIndex } from "./session/index.js";
