/**
 * M0 cross-milestone compatibility contract for the default Coding Agent.
 * Change these values only as an explicit product behavior decision.
 */
export const CODING_AGENT_BEHAVIOR_BASELINE = Object.freeze({
  agentId: "coding",
  description: "Local coding agent with filesystem, shell, search, web, and skills capabilities.",
  manifestApiVersion: "omni-agent/v2",
  blueprintApiVersion: 2,
  systemPromptDigest: "a2e8710fdffa533d0a216a42600361548ec7bffc7c48a54b697311870b752cb2",
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
  ]),
  hostCommandNames: Object.freeze([
    "config",
    "permissions",
    "help",
    "new",
    "clear",
    "skills",
    "trace",
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
