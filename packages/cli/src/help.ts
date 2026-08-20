export const CLI_HELP = `Omni Agent

Usage:
  omni [--trace]               Start the coding agent
  omni run [agent-id] [--trace]
                               Start an agent (default: coding)
  omni trace preview <agent>   Open the local Trace viewer for an agent
  omni trace clear <agent>     Clear local Trace data after confirmation
  omni doctor                  Check local runtime readiness
  omni --help                  Show this help
  omni --version               Show the CLI version

Options:
  --trace                      Capture sanitized local traces for this process
`;
