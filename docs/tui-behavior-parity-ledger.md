# TUI Behavior Parity Ledger

This ledger is the acceptance source for the Agent-neutral TUI ownership migration. The migration
changes owners and dependency direction only. User-visible behavior is intentionally unchanged.

| Unit                | Previous owner                 | Current owner                  | Input and state                                    | Output and ordering                                        | Cancellation and release                                  | Evidence                            |
| ------------------- | ------------------------------ | ------------------------------ | -------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------- |
| Terminal runtime    | `packages/cli/interaction/tui` | `packages/ui/terminal/runtime` | terminal input, focus, scroll, editor text         | layout, transcript, editor, status                         | TUI Ctrl+C unchanged; Host owns graceful process signals  | interaction/lifecycle tests + smoke |
| Inline select       | CLI TUI                        | UI component                   | options, selected index, links                     | same keyboard/mouse selection result                       | Escape, AbortSignal, shutdown restore editor focus        | migrated select tests               |
| Inline multi-select | CLI TUI                        | UI component                   | options, selected set                              | same item and action order                                 | Escape, AbortSignal, shutdown restore editor focus        | migrated multi-select tests         |
| Inline text input   | CLI TUI                        | UI component                   | placeholder, required state, buffer                | same submitted text                                        | Escape, AbortSignal, shutdown restore editor focus        | migrated text-input tests           |
| Markdown            | CLI TUI                        | UI component                   | markdown stream                                    | same ANSI, wrapping, code and hyperlink output             | component lifecycle only                                  | migrated markdown tests             |
| Disclosure          | CLI TUI                        | UI component                   | disclosure ViewModel, expanded state               | same title/detail/state and URL                            | 1000 ms ticker stops with terminal                        | migrated disclosure tests           |
| Run projection      | CLI presentation               | UI presentation                | StreamCallbacks, accumulated nodes                 | text, tool, thinking, compression, final and metrics order | pending 50 ms render is flushed/cancelled                 | migrated router/model tests         |
| Tool projection     | CLI presentation               | UI presentation                | batch/tool lifecycle events                        | same batch membership, status, duration and output         | terminal run cancellation leaves no pending timer         | migrated presenter tests            |
| Thinking            | CLI presentation               | UI presentation                | start/delta/end                                    | same disclosure lifecycle                                  | 50 ms throttle; completion and cancellation clear timer   | migrated presenter/router tests     |
| Compression         | CLI presentation               | UI presentation                | context progress events                            | same status, summary and detail                            | no independent resources                                  | migrated presenter tests            |
| History             | CLI presentation + TUI         | UI presentation + runtime      | transcript, visible turn count                     | header, initial 10 turns, earlier history, resumed divider | load callback retained by UI and removed on clear         | migrated history tests              |
| Permission          | CLI adapter                    | UI adapter                     | generic ApprovalRequest                            | persistent approval, Allow once, Deny order                | AbortSignal and shutdown keep existing response semantics | migrated approval tests             |
| Command interaction | CLI adapter                    | UI adapter                     | CommandSelectionOptions                            | same InteractionRequest mapping and result validation      | Abort/escape/shutdown mapping unchanged                   | migrated adapter tests              |
| Skill preload       | CLI flow + renderer            | CLI flow + UI renderer         | resolved preload data                              | explicit start/end before Agent run                        | read errors remain CLI-owned                              | full tests + shared console port    |
| Onboarding          | CLI mixed flow                 | CLI workflow + UI interaction  | provider/model/auth data and explicit list looping | Provider → Auth → Model → ready summary                    | model login/config persistence remain CLI-owned           | type boundary + onboarding tests    |
| Trace preview       | CLI + UI                       | Host + UI                      | agent id and local query                           | same URL, security headers, read-only APIs                 | SIGINT/SIGTERM close server                               | preview server + architecture tests |
| Agent run           | CLI                            | CLI                            | Blueprint, AgentFactory, session, AbortController  | prompt/tools/events/session behavior unchanged             | Agent and model disposal remain CLI-owned                 | consecutive-turn test + CLI smoke   |

## Locked invariants

- Thinking render throttle: 50 ms.
- Run text render throttle: 50 ms.
- Disclosure ticker: 1000 ms.
- Initial restored history: 10 turns.
- Autocomplete maximum: 10 items.
- Permission order: persistent approval, Allow once, Deny.
- Ctrl+C abort and double-press exit behavior is unchanged.
- Provider, connection, and model lists stop at their boundaries; authentication and configuration
  action lists wrap at their boundaries, matching the previous Inquirer behavior.
- OS-level SIGINT and SIGTERM are owned by the Host and perform graceful resource cleanup; this is
  an intentional lifecycle improvement outside the TUI key-handling parity contract.
- Restored-session header, divider, history order, and Tool/Thinking/Compression order are unchanged.
- Consecutive submitted turns reuse one Console, AgentApplication, and Session. Each submitted input
  still invokes the existing `AgentApplication.run()` exactly once and therefore retains the existing
  one-Trace-Run-per-application-run capture contract.

## Dependency acceptance

```text
apps/omni -> packages/cli, packages/ui, packages/app
packages/cli -> packages/app, packages/core, packages/tools, agents/*
packages/ui -> packages/app, packages/core
```

`packages/cli` and `packages/ui` do not import each other. UI does not import or branch on a
concrete Agent. Repository-level architecture tests enforce these constraints.
