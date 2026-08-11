# xdnloveme

A modular agent runtime with a default coding agent, TUI interaction, multi-provider LLM support, local tools, skills, and session history.

Repository: [github.com/xdnloveme/omni-agent](https://github.com/xdnloveme/omni-agent)

## Quick Start

```bash
pnpm install
pnpm dev # Start the default coding agent
```

On first launch, you'll be guided to configure a provider and API key.

## Project Structure

Monorepo managed by pnpm workspace:

```
packages/
  core/   # Agent loop, tools, messages, and stable runtime ports
  models/ # Model runtime, vendor catalog, provider plugins, and credentials
  app/    # Application facade, registries, extensions, sessions, config
  tools/  # Domain-neutral filesystem, shell, search, and web tools
  cli/    # Process entry, TUI, chat mode, and onboarding

agents/
  coding/              # Default coding agent extension
  financial-analysis/ # Optional read-only financial analysis extension
```

The models package depends on core; app composes both. Concrete agents are never
registered implicitly by core or app.
Each Agent package exports an `agentBlueprint`; the CLI loads
`@omni-agent/agent-<id>` by convention, so adding an installed Agent does not
require another CLI branch.
Agent sessions are isolated under `~/.omni-agent/sessions/<agent-id>/`; switching
Agent IDs never restores another Agent's conversation history. Starting the same
Agent restores its most recently active persisted Session.

## Provider credentials

Providers are presented vendor-first, then by connection and model. Credentials
use runtime precedence: an explicit request value, the OS credential store
(keytar), then process variables, the current project's `.env`, and finally the
global `~/.omni-agent/.env`. Copy `.env.example` to `.env` when file-based
project credentials are preferred; the CLI reads but never writes environment
files.

Non-secret configuration is layered from the global `~/.omni-agent` directory
and `omni.config.json` / `omni.providers.json` in the project root. A shared model
is the default for every Agent, while `agents.<id>.model` optionally overrides it.
Project Agent overrides win over global Agent overrides, followed by project and
global shared defaults. Provider vendors merge by `id` and
connections by `id`, with project connections replacing matching global
connections. Invalid project files are reported instead of silently falling
back to global configuration. Project configuration can be committed; secrets
remain in keytar or an ignored `.env` file.

Provider plugins compose connection-level Factory strategies rather than building
adapters in Core. Agent-facing connection settings use a constrained JSON Schema
contract compiled once with Ajv; local Provider definitions are validated and
persisted through a single atomic repository.

## Runtime permissions

Tool inputs are validated and explicitly routed before execution. Trusted internal
tools, such as Skill loading and deterministic in-memory computation, do not consult
permission state. Permission-controlled tools are assessed before execution. The
default `standard` mode allows routine workspace reads and writes, while asking before shell
execution and higher-risk operations. `supervised` mode also asks before writes.
External, destructive, unknown, and privileged operations always require a one-time
decision. Explicit hard-stop operations are denied.

The approval prompt supports allowing one call, automatically approving routine
calls to that tool for the current Agent, or denying the call. Automatic approvals
are stored in `~/.omni-agent/permissions.json`. They do not bypass later external,
destructive, unknown, or privileged classifications.

This layer is an execution policy, not an OS sandbox. It cannot fully constrain an
untrusted child process or eliminate filesystem race conditions.

The complete tool-call, authorization, execution, cancellation, persistence, and
future sandbox contract is documented in
[`docs/tool-call-runtime.md`](docs/tool-call-runtime.md).

## Development

```bash
pnpm dev                          # Start the default coding agent
pnpm run dev -- <agent-id>        # Start an installed agent package dynamically
pnpm run dev:coding               # Start the coding agent explicitly
pnpm run dev:financial-analysis   # Start the read-only financial analysis agent
pnpm run format       # Format source, tests, config, and docs
pnpm run format:check # Verify formatting without changing files
pnpm run typecheck    # Type checking
pnpm run test         # Run tests
pnpm run test:watch   # Test watch mode
```

Pre-commit hook (husky) automatically runs `format:check + typecheck + test` to ensure commit quality.

## Slash Command System

Built-in commands are registered via `CommandRegistry` and triggered by typing `/command` at runtime:

- `/config` — Reconfigure provider
- `/permissions` — Change permission mode and revoke automatic tool approvals
- `/help` — List available commands

**Adding a new command:**

1. Create a new file in `packages/core/src/commands/` or `packages/cli/src/commands/`, implementing the `Command` interface
2. Register it in the corresponding `index.ts` with `registry.register(yourCommand)`

```ts
// Command interface
interface Command {
  name: string;
  description: string;
  execute(ctx: CommandContext): Promise<void>;
}
```

## Tech Stack

- TypeScript, Node.js ≥ 22.19
- [@earendil-works/pi-ai 0.84](https://github.com/earendil-works/pi) — Provider-based model runtime
- [pi-tui](https://github.com/nicepkg/pi-tui) — Terminal UI
- Vitest — Testing
- Husky — Git hooks
- pnpm workspace — Monorepo management
