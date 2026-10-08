# Benchmark evaluation

The benchmark integration invokes the production coding Agent through `apps/omni/src/headless-entry.ts`. `packages/cli/src/headless/run.ts` owns one new Session and one Run; the Apps composition owns the Service, model resources, signal handling and final Trace query. Harbor adapters and evaluation data belong under `benchmark/`; production packages do not import them.

The headless entry requires explicit `--confirm-unrestricted` plus `--cwd`, `--input-file`, `--config-file`, `--providers-file` and `--output-dir`. It creates a new `state` directory under the output directory and refuses to reuse an existing one. Only that fresh state receives unrestricted execution settings. The caller must supply an isolated execution environment; this flag does not create an OS sandbox.

Output uses version 1 JSON. `request.json` reserves one attempt; `started.json` records the created Session before Run submission; `result.json` records the terminal outcome and native Trace association after Service disposal. Exit codes are 0 for completed, 130 for cooperative cancellation and 1 for failure. GNU timeout or OS termination can produce their own nonzero exit codes without a complete result file.

Trace association uses the existing query by Session ID and `TraceStorageLayout`. Exactly one valid native Run is required. Missing, ambiguous, unreadable, degraded or unfinished capture is reported explicitly. `lastTurnUsage` is nullable and remains in its native schema; it is not the sum of all model calls. The returned `replayFile` points to the native per-call records. A matching completed manifest proves lifecycle completion, not lossless accounting or task correctness.

## Evaluation boundary

The launcher freezes selection and configuration before execution. Completion is reconciled per task and Agent configuration against Harbor's native results; missing runs, duplicate runs, execution failures and valid zero scores remain distinct. Model usage and score are separate facts. Invalid native results must not publish scores or costs; invalid adapter evidence must not erase a valid native score.

Preparation may access the network to build dependencies and validate official empty/reference-patch controls. Solver tools run without external network access. Omni model transport runs in a separate process/container through the existing Provider implementation and an isolated, pre-established channel; credentials are not injected into the solver. After solver processes stop and submission is sealed, an independent verifier applies the submission and uses the taskpack's declared network policy. SWE verification uses public networking for official test resources.

Task identity, source revision, image digest, Agent source archive, configuration and native evidence are retained for reproduction. Environment controls do not measure Agent capability. Trusted in-process extensions and external test resources remain trust assumptions; this is not an adversarially hardened evaluation service or a leaderboard-equivalent result.

See [benchmark usage, validation and limitations](../benchmark/README.md) for maintained commands and the current acceptance boundary. Implementation plans and individual debugging records are local development artifacts, not additional contract sources.
