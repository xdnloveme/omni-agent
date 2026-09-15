# Omni benchmark

Harbor provides task environments, scheduling and scoring. Omni runs its production coding Agent inside each task container through a separate headless process. There is no benchmark-specific model client, Agent loop or tool implementation.

## Current status

The headless entry, isolated task adapter and per-run tracking are implemented.
Real Babel and Docusaurus trials both scored 1, completed naturally and retained
complete Trace. See [the two-task report](reports/two-new-swe-2026-09-15.md).
Earlier Axios runs exposed one unresolved missing-terminal incident and a separate
Agent stash/timeout failure; their evidence remains available in the reports.
These selected trials validate integration and do not establish a population score.

- Harbor 0.23.0 and Python 3.12 are pinned by `pyproject.toml` / `uv.lock`.
- The initial adapter supports Debian/Ubuntu **amd64** task images and `/testbed` workspaces. Other environments must be validated before use.
- Omni uses private Node 22.19.0 and pnpm 11.5.1. Installation does not replace the task's Node or add Omni's Node to the task tool PATH.
- The selected model is `volcengine-agent-plan/default/glm-5.2`, resolved by the existing `omni.config.json` and `omni.providers.json`.
- Only the configured credential environment variable is passed to the Omni process. Never put keys in YAML, image layers or this directory.

## Run one task

Run from the repository root with Docker and its Compose plugin available, and `ARK_AGENT_PLAN_API_KEY` already in your process environment:

```bash
uv sync --project benchmark
uv run --project benchmark python -m benchmark.run run \
  --kind paid --config benchmark/configs/harbor/swe-single-isolated.yaml
```

For the deterministic local-model integration fixture (no external API requests):

```bash
OMNI_SMOKE_API_KEY=fixture uv run --project benchmark python -m benchmark.run run \
  --kind fixture --config benchmark/configs/harbor/smoke.yaml
```

For the local-model cancellation fixture, use the standalone `smoke-timeout.yaml` configuration instead of `smoke.yaml`. It expects an AgentTimeoutError and cancelled native Trace, not reward 1. Do not combine these configurations: Harbor appends Agent lists.

Use `--install-only` for an installation check that sends no model request. A remote Docker daemon must be able to mount the selected `--jobs-dir`; share only a dedicated evaluation directory. On arm64 hosts the selected upstream image requires amd64 emulation.

The configuration freezes `axios__axios-4731` at dataset commit `61366953049fd63a7dff54f67193bf39f5d1cde6`. Its upstream instruction contains hints, which are preserved. There is one attempt, concurrency one and no Harbor retries. The SWE configurations allow 1800 seconds (30 minutes) for the Agent process; GNU timeout then sends SIGTERM and allows five seconds for process cleanup. Harbor has an outer 1830-second bound to leave room for cleanup and artifact collection. Historical runs retain their recorded 590/600-second budgets. This is a time bound, not a token or monetary cap. Production model transport retains its existing behavior.

## Boundaries and evidence

The adapter packages Git-listed production source files and retains the exact source archive, SHA-256 and base commit in the job's `agent/setup/` directory. This includes uncommitted implementation changes; the base commit alone does not identify those bytes.

Each invocation creates a new Session and an exclusive state directory in the container user's HOME, collected afterward under `agent/omni/state/`. `request.json`, `started.json` and `result.json` identify the invocation and its native Trace. `events.jsonl`, `stderr.log` and `changes.patch` support diagnosis. A forced process kill can leave only partial artifacts; missing output is not success and missing usage is not zero. `lastTurnUsage` is the final turn's runtime accounting, not a whole-trial token sum. Raw native per-call usage is retained in Trace; an unverified zero cost is not a bill.

Omni runs as an ordinary container user. Test and reward directories are protected during Agent execution, and Harbor injects the verifier afterward. The upstream verifier runs code modified by the Agent in the same container: this protocol is **not an adversarial anti-cheating boundary**. The scope decision and final runtime evidence are tracked in the implementation plan.

Harbor's native trial result and verifier logs own the score. A completed Omni Run does not imply a resolved SWE task. Do not infer a population score from this single selected task.

See [the implementation plan](../docs/plans/benchmark-integration-v1.md) for stage gates, remaining work and quality evidence.

## Per-run diagnostic retention

Use `python -m benchmark.run run` for every real paid invocation. It assigns a
UTC/UUID run ID and persists `invocation.json` **before** launching Harbor, then
writes `analysis-index.json` when the launcher exits. The index links each trial
to its original artifacts, native Session/Run IDs and Trace completeness checks.
It records missing or malformed evidence without repairing or rewriting it.
`launcher.log` captures Harbor's console output. The command prints the artifact
directory immediately; inspect that directory while the process runs.

`--kind paid` declares the intended model path, not actual billing. The launcher
inherits the existing credential environment but does not serialize it. The
record contains the original config path/hash and an immutable `launch-config.yaml`
snapshot actually passed to Harbor; Harbor retains resolved config,
and Omni retains the source and input manifests. Direct `harbor run` remains an
upstream entry and does not create this benchmark invocation record.

After an interrupted launcher or for an older job, rebuild only the analysis index:

```bash
uv run --project benchmark python -m benchmark.run index benchmark/jobs/<run-id>
```

A launcher exit is not a successful evaluation or proof of container cleanup.
An uncatchable kill can leave invocation state `running`; inspect raw artifacts
and process state before deciding whether the run finished. Indexing never reruns
the Agent or makes model calls. No automatic retries or deletion are added.

Every evaluation attempt keeps its own Harbor job/trial directory. Keep successful,
failed and timed-out attempts for local analysis; use a fresh job name for each
invocation. The default `jobs_dir` is `benchmark/jobs`. If Docker requires a shared
external `--jobs-dir`, retain that directory or archive the completed job under
`benchmark/artifacts/<job-name>/` before deleting the external files.

```text
benchmark/jobs/<job-name>/
├── invocation.json, launch-config.yaml  Benchmark identity and exact input config
├── launcher.log                         Harbor console output
├── analysis-index.json                  Rebuildable references and evidence checks
├── config.json, result.json, job.log      Harbor job configuration and outcome
└── <trial-name>/
    ├── result.json                      Trial outcome and verifier reward
    ├── exception.txt                    Present when the trial fails
    ├── agent/
    │   ├── setup/                       Exact source archive/hash and install log
    │   ├── instruction-*.txt            Rules, original and submitted task input
    │   ├── instruction-manifest.json    Input hashes
    │   ├── process-exit.json            Exit code and elapsed time, if exec returned
    │   └── omni/
    │       ├── request.json, started.json, result.json
    │       ├── events.jsonl, stderr.log  Service events and shutdown diagnostics
    │       ├── changes.patch            Submitted workspace changes
    │       └── state/traces/coding/<session-id>/<run-id>/
    │           ├── manifest.json        Run status and capture metadata
    │           ├── replay.jsonl         Native per-turn model/tool lifecycle
    │           └── payloads/            Native payload storage when present
    └── verifier/                        Official test output and reward
```

Reuse native Trace to inspect each model turn, tool arguments/results, errors,
usage and cancellation. A Bash test command is a tool call in this same Trace;
do not add a second model/tool transcript or an alternative Trace writer.
Test output remains subject to the tool's existing capture limits and the command's
own redirection (for example, `tail`); Trace cannot recover output the command did
not return. `stderr.log` supplements Trace with process signals and shutdown
phases, while Harbor's verifier output remains the scoring source of truth.

Both `/benchmark/jobs/` and `/benchmark/artifacts/` are Git-ignored, including all
nested Trace and payload files. Raw artifacts are for local analysis; curated
reports in `benchmark/reports/` may reference them but should not copy credentials
or entire raw traces into tracked files. Git-ignore prevents accidental tracking,
not external sharing of sensitive content.

Check `agent/omni/result.json` and its Trace integrity before declaring evidence
complete. Installation failure, forceful termination or artifact collection
failure can leave files absent or partial. Submission collection failure still
attempts diagnostic download after stopping the solving user, and the failure is
propagated rather than treated as success. Preserve those attempts as incomplete
evidence rather than synthesizing missing terminal events. Logging and retention
do not alter the production Agent loop, tool execution or scoring semantics.

## Isolated protocol: initial implementation

The original `swe-single.yaml` still uses public networking/shared verification. New adapter invocations now prepend versioned evaluation rules and retain the original, rules, submitted text and hashes; historical job inputs are unchanged.

The isolated task generator defaults to the pinned Axios task. Other tasks in the same pinned SWE Multilingual dataset accept an explicit task name and digest-pinned image. Prepare a fresh output from the repository root:

```bash
PYTHONPATH="$PWD" uv run --project benchmark python -m benchmark.adapters.harbor.prepare_task \
  --output-dir benchmark/artifacts/tasks/axios-isolated
```

The corresponding configuration is `benchmark/configs/harbor/swe-single-isolated.yaml`. Do not set a global `DOCKER_DEFAULT_PLATFORM` for this workflow: Harbor's egress sidecar uses the daemon architecture; the verifier main service declares amd64 explicitly. A remote daemon still requires a shared jobs directory.

The first integrated local-model run passed using model-host allowlisting and separate offline verification. The official SWE verifier also passed the known-solution Oracle check, and an empty patch failed offline. These are integration checks, not Agent capability scores. See [the isolation report](reports/isolation-2026-09-15.md) for exact evidence and remaining gates.

Submissions contain Git-tracked changes and non-ignored new files relative to the recorded baseline, capped at 16 MiB. The verifier rejects new symlinks/submodules and unsafe or inapplicable patches. It refreshes Git's index stat cache, applies the submission, then delegates to the unchanged upstream grader.

Run the input/submission contract tests without a model:

```bash
PYTHONPATH="$PWD" uv run --project benchmark python -m unittest discover -s benchmark/tests -v
```

The network diagnostic is `benchmark/tests/probe_network.py --output-dir <fresh-shared-directory>`. It uses native Harbor environments and uncredentialed HTTP requests. The native separate-verifier fixture is `benchmark/tasks/isolation-probe`, run with Harbor's Oracle agent.

## Two additional repository trials

`swe-two.yaml` runs Babel 13928 and Docusaurus 10130 sequentially, once each,
with 1800-second Agent budgets and full per-run tracking. Prepare their immutable
task directories before running:

```bash
uv run --project benchmark python -m benchmark.adapters.harbor.prepare_task \
  --task-name babel__babel-13928 \
  --image swebench/sweb.eval.x86_64.babel_1776_babel-13928@sha256:f31287983c8bbbd73677e5bac8e7c6d43ea988cb1f413424fd0def12be305675 \
  --output-dir benchmark/artifacts/tasks/babel-isolated-v2
uv run --project benchmark python -m benchmark.adapters.harbor.prepare_task \
  --task-name facebook__docusaurus-10130 \
  --image swebench/sweb.eval.x86_64.facebook_1776_docusaurus-10130@sha256:e48084f281e6363e77c1cbde079d6f54ee26e94250e79370eef4ac92cb616542 \
  --output-dir benchmark/artifacts/tasks/docusaurus-isolated
uv run --project benchmark python -m benchmark.run run \
  --kind paid --config benchmark/configs/harbor/swe-two.yaml
```

Existing task output directories are never overwritten. The verifier's prewarm
step restores tracked files and removes non-ignored untracked files before
sealing the image, so upstream injected fixtures cannot leak into the evaluation
baseline. The original upstream grader and task instruction remain byte-identical.
Each new task still needs offline empty-patch and native Oracle validation before
its paid result is considered trustworthy; accepting parameters does not certify
arbitrary languages or task images.
