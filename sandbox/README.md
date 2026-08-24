# Omni Sandbox

`omni-sandbox` is the macOS process launcher used by controlled and autonomous Agent execution.
It validates a versioned invocation, installs a Seatbelt profile, applies bounded file descriptor
and file-size limits, and then replaces itself with the requested command. Tool policy, prompts,
timeouts, output collection, and user interaction remain in the TypeScript runtime.

The first release supports macOS only. It does not provide an overlay filesystem, fake deletion,
automatic rollback, strict memory limits, or isolation for trusted in-process tools.

The sandbox is a single Rust package rooted directly in this directory. `pnpm run dev` and
`pnpm run build` compile the current-host release binary before starting or building the
TypeScript application. `pnpm run build:cli` separately cross-builds and packages both supported
macOS architectures.

## Protocol

Protocol v3 accepts canonical workspace, private-temp, read/write scope, network, sensitive-read,
protected-write-root, and per-launch diagnostic-token arguments before `-- <command> <args...>`.
Node and Rust validate policy
paths independently. Read scopes preserve lexical paths where dynamic loaders or PATH symlinks
require them; canonical targets are projected separately by Node. Controlled and autonomous
execution fail closed on a missing or mismatched binary; there is no host fallback.

A writable subtree permits real creation, modification, and deletion below the root. Each
`--protect-write-root` prevents deleting or renaming that root itself. The workspace is always
protected, and the Runtime protects each read/write subtree projected for the current call.
Sensitive deny rules still take precedence over broad ordinary scopes.

The CLI distribution builds and packages both `darwin-arm64` and `darwin-x64` launchers. Runtime
resolution selects the matching architecture and fails closed if that binary is unavailable.

The Rust entry delegates policy installation and target replacement through a platform module.
Only the macOS backend currently exists. Adding Linux or Windows requires a backend that enforces
the complete protocol semantics; a partial implementation must remain unsupported rather than
silently weakening policy.
