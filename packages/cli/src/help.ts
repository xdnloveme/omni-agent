export const CLI_HELP = `Omni Agent

Usage:
  omni [--trace]               Start the coding agent
  omni run [agent-id] [--trace]
                               Start an agent (default: coding)
  omni trace preview <agent>   Open the local Trace viewer for an agent
  omni trace clear <agent>     Clear local Trace data after confirmation
  omni agent describe <agent> [--json]
                               List available Agent components and dependencies
  omni agent validate <agent> [--json]
                               Validate the Agent recipe without building runtime resources
  omni agent plan <agent> [--json]
                               Show the resolved Prompt, Tool and Capability composition
  omni doctor                  Check local runtime readiness
  omni --help                  Show this help
  omni --version               Show the CLI version

Options:
  --trace                      Capture sanitized local traces for this process
  --json                       Emit a machine-readable inspection document
`;
