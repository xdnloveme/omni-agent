/**
 * M0 cross-milestone compatibility contract for the default Coding Agent.
 * Change these values only as an explicit product behavior decision.
 */
export const CODING_AGENT_BEHAVIOR_BASELINE = Object.freeze({
  agentId: "coding",
  description: "Local coding agent with filesystem, shell, search, web, and skills capabilities.",
  manifestApiVersion: "omni-agent/v2",
  blueprintApiVersion: 2,
  systemPromptDigest: "e283a8d304195b673a816e69e472ee129a3ce2f1a5051e159a5ebee3d58c4fb7",
  toolNames: Object.freeze([
    "bash",
    "file_read",
    "file_edit",
    "file_write",
    "glob",
    "grep",
    "web_fetch",
    "web_search",
    "request_user_input",
    "skill_read",
    "output_read",
  ]),
  hostCommandNames: Object.freeze([
    "config",
    "permissions",
    "help",
    "new",
    "clear",
    "skills",
    "trace",
    "mcp",
  ]),
  promptAnchors: Object.freeze([
    "# Communication",
    "# Tool Usage",
    "# Execution and Verification",
    "# Instruction Boundaries",
    "# Safety",
    "# Philosophy",
  ]),
  traceManifestVersion: 1,
  contextCheckpointVersion: 1,
});
