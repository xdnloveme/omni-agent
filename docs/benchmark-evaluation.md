# Benchmark evaluation

The benchmark integration invokes the production coding Agent through `apps/omni/src/headless-entry.ts`. `packages/cli/src/headless/run.ts` owns one new Session and one Run; the Apps composition owns the Service, model resources, signal handling and final Trace query. Harbor adapters and evaluation data belong under `benchmark/`; production packages do not import them.

The headless entry requires explicit `--confirm-unrestricted` plus `--cwd`, `--input-file`, `--config-file`, `--providers-file` and `--output-dir`. It creates a new `state` directory under the output directory and refuses to reuse an existing one. Only that fresh state receives unrestricted execution settings. The caller must supply an isolated execution environment; this flag does not create an OS sandbox.

Output uses version 1 JSON. `request.json` reserves one attempt; `started.json` records the created Session before Run submission; `result.json` records the terminal outcome and native Trace association after Service disposal. Exit codes are 0 for completed, 130 for cooperative cancellation and 1 for failure. GNU timeout or OS termination can produce their own nonzero exit codes without a complete result file.

Trace association uses the existing query by Session ID and `TraceStorageLayout`. Exactly one valid native Run is required. Missing, ambiguous, unreadable, degraded or unfinished capture is reported explicitly. `lastTurnUsage` is nullable and remains in its native schema; it is not the sum of all model calls. The returned `replayFile` points to the native per-call records. A matching completed manifest proves lifecycle completion, not lossless accounting or task correctness.

For the initial SWE trial, use the upstream Harbor verifier without editing its tests or reward logic. Preserve the upstream hints and record the task source commit, image digest, exact Omni source archive, model configuration, runtime versions and architecture/emulation. Agent completion and reward are separate facts. Keep unresolved, timeout and infrastructure failure distinct; never silently drop failed trials from the selected-task denominator.

The original public/shared protocol verifier shares the task container and executes modified repository code. Ordinary-user Agent execution protects grading directories during the solving phase; it does not prove resistance to an adversarial Agent that tampers with later test execution. Do not describe this integration as a hardened evaluation service or publish a leaderboard-comparable score without documenting protocol differences.

See [benchmark usage](../benchmark/README.md) and [the implementation plan](plans/benchmark-integration-v1.md). The first full trial completed with reward 1 and complete Trace, but it fetched the public upstream solution. See [the single-trial report](../benchmark/reports/swe-single-2026-09-14.md) for evidence, usage and limitations; this is integration evidence, not an independent capability score.

## Isolation implementation status

The isolated protocol now uses native model-host allowlisting, explicit patch transfer and a separate verifier with Compose network_mode none. The adapter prepends versioned evaluation rules and records exact input hashes. Production system prompts are unchanged. Local-model integration, offline official-grader controls and real isolated Babel/Docusaurus trials passed. Both new tasks completed naturally with reward 1 and complete Trace. The protocol is still not an adversarially hardened service; the original Axios missing-terminal incident remains unresolved. See [the evidence report](../benchmark/reports/isolation-2026-09-15.md).

See [current real-run evidence](../benchmark/reports/two-new-swe-2026-09-15.md). The tracked launcher snapshots its input configuration before starting Harbor. If submission collection fails, the adapter still attempts to download existing diagnostics after stopping solving-user processes and reports the collection failure.
