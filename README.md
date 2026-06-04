# omni-agent

A personal assistant agent — TUI-based interaction with multi LLM provider support (OpenAI, Anthropic, etc.).

## Quick Start

```bash
pnpm install
pnpm dev
```

On first launch, you'll be guided to configure a provider and API key.

## Project Structure

Monorepo managed by pnpm workspace:

```
packages/
  core/   # Core logic: agent loop, LLM calls, config, command system
  cli/    # TUI interface, onboarding, tool implementations
```

## Development

```bash
pnpm dev              # Start dev (runs directly via tsx)
pnpm run typecheck    # Type checking
pnpm run test         # Run tests
pnpm run test:watch   # Test watch mode
```

Pre-commit hook (husky) automatically runs `typecheck + test` to ensure commit quality.

## Slash Command System

Built-in commands are registered via `CommandRegistry` and triggered by typing `/command` at runtime:

- `/config` — Reconfigure provider
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

- TypeScript, Node.js ≥ 20
- [pi-ai](https://github.com/nicepkg/pi-ai) — Unified LLM calls
- [pi-tui](https://github.com/nicepkg/pi-tui) — Terminal UI
- Vitest — Testing
- Husky — Git hooks
- pnpm workspace — Monorepo management
