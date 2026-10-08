# Benchmark

English | [简体中文](README.zh-CN.md)

An Agent evaluation environment built on Harbor 0.23.0. The shared mechanisms do not depend on the evaluated Agent framework. Omni is the first adapter; SWE is the first taskpack. Supported containers are currently Linux Debian/Ubuntu amd64.

## Responsibilities

- `run.py`: configuration checks, invocation registration, evidence indexing, and reports.
- `adapters/omni/`: Omni installation, startup, evaluation input projection, and native Trace evidence.
- `environments/runtime.py`: runtime declarations, readiness probes, and environment preparation.
- `environments/handoff.py`: solver process shutdown, artifact sealing, and submission validation.
- `taskpacks/swe/`: upstream task preparation, the Git patch collector, independent official grading, and its network policy.

The integration reuses Harbor BaseInstalledAgent/BaseAgent, task.toml, AgentContext, collect, and artifacts. Benchmark does not add another scheduler or Provider client, or own the Agent's task-solving strategy. The Omni adapter uses the production model service.

## Prerequisites

Use the repository's required Node/pnpm versions and Python 3.12. Dependencies are pinned in `pyproject.toml`/`uv.lock`. Verify that `docker version`, `docker compose version`, and `docker buildx version` can access the selected daemon. Docker contexts and CLI plugin directories are local machine settings, not task or product configuration.

The daemon must be able to mount the job directory. The launcher checks actual file visibility through a read-only temporary container and refuses to start the Agent on failure. For remote daemons or restricted Colima shares, explicitly select a shared `--jobs-dir`; host directory existence alone is insufficient.

```bash
uv sync --project benchmark --frozen
export PYTHONPATH="$PWD"
```

## Unified commands

Run from the repository root. Selection, configuration, and execution logic live in `benchmark/`; the root package script only maps the command.

```bash
# Free preview: reads the manifest, without checking preparation cache readiness
pnpm run benchmark list --all
pnpm run benchmark list --task sphinx-doc__sphinx-11510

# Free preparation: builds and validates containers, without model credentials
pnpm run benchmark prepare --first 3

# Free static validation: checks argument structure, not credential values or readiness
pnpm run benchmark check --profile benchmark/configs/omni.local.json --first 3

# Real model runs: first create the user profile and supply credentials as described below
pnpm run benchmark run --profile benchmark/configs/omni.local.json --all --concurrency 5
pnpm run benchmark run --profile benchmark/configs/omni.local.json --task sphinx-doc__sphinx-11510
pnpm run benchmark run --profile benchmark/configs/omni.local.json --first 3
pnpm run benchmark run --profile benchmark/configs/omni.local.json --first 10 --concurrency 5
pnpm run benchmark run --profile benchmark/configs/omni.local.json --sample 5 --seed 42 --concurrency 5

# Explicit cache, Agent budget, and Docker-shared job directory
pnpm run benchmark run --profile benchmark/configs/omni.local.json --first 3 --task-root benchmark/artifacts/my-prepared-suite \
  --timeout 1800 --jobs-dir benchmark/jobs

# Native Harbor configuration uses the same tracked_run entry; prepare fixtures first
pnpm run benchmark check --config benchmark/configs/harbor/smoke.yaml
pnpm run benchmark run --config benchmark/configs/harbor/smoke.yaml --kind fixture
pnpm run benchmark report benchmark/jobs/JOB_ID
```

The default profile is `configs/default.json`; select another with `--profile PATH`. Profile `manifest` and `task_root` paths resolve relative to the profile directory. CLI paths resolve relative to the current directory. `execution` is a Harbor job configuration. Agent and Provider settings belong to the adapter; shared selection code does not read model credentials.

The default profile does not bind Provider credentials and can prepare environments without them. For real runs, copy it to `configs/omni.local.json` in the same directory (Git-ignored), add these `kwargs` to `execution.agents[0]`, and select that profile:

```json
{
  "credential_env": "MY_MODEL_API_KEY"
}
```

This is the contents of `kwargs`, not a complete profile. By default Omni uses the normal configuration layers for this checkout and `~/.omni-agent`: project Agent override, global Agent override, project shared model, then global shared model. ConfigService owns this precedence; ProviderRepository owns Provider merging. `configuration_cwd` and `global_directory` explicitly select other configuration sources. Use absolute paths when overriding them. The task workspace is only the execution directory and cannot override this captured configuration. Interactive coding may enter onboarding when configuration is missing; benchmark is non-interactive and returns the production model/configuration validation failure instead.

Optional `config_file` and `providers_file` override the project-layer input files; they do not remove global layers. Use absolute paths for these overrides. `preparation.adapter.options.source` chooses code to package, not the model configuration source. The free smoke fixture explicitly selects its test configuration and an empty global layer so it cannot inherit a developer's global Agent override.

`credential_env` names the one authentication variable allowed into the isolated model service. It must match the selected Provider. The value is resolved by Models using the normal order: process environment, workspace `.env`, then global `.env`. Only the selected value is transferred; `.env` files and unrelated variables are not copied. Do not put keys in profiles. Host Keychain and OAuth state are not supported by this isolated deployment.

`prepare` requires neither model configuration nor credentials. `check` checks adapter option structure without resolving models, validating credentials, or calling a model. Real `run` invokes the formal App/Models validation during Harbor preflight before capacity checks and preparation, then captures and validates again during Agent installation. Both automatic preparation and native `--config` runs use this same adapter path. No model request is made by these checks.

Each trial stores its public layered configuration and merged Provider definitions under `agent/configuration/`, with source paths and file hashes in `snapshot.json`. One snapshot feeds both solver configuration and the model service. Provider definitions and credentials go only to the model service; the solver receives the Agent configuration layers. Credentials are transferred through a private temporary file that the model service consumes and deletes. They are absent from the public snapshot. Configuration does not enter the image cache key, so changing only a model does not rebuild images.

- Choose exactly one of `--all`, `--task`, `--first`, or `--sample`. Repeat `--task` for multiple IDs; invalid or duplicate IDs are rejected.
- `--first N` follows manifest order. `--sample N --seed S` samples without replacement; selected IDs are then ordered by the manifest. Recorded IDs are authoritative rather than future resampling.
- `--concurrency N` must be positive and overrides the profile. The default is 1. With 5, Harbor admits up to five trials and fills each available slot; it does not wait for groups of five. Each task gets one attempt, with no automatic retries.
- `--timeout` sets the Agent budget to 1–1800 seconds, excluding image preparation and Agent setup. Shutdown grace is separate.
- Each `run` records the effective job configuration, selected IDs, seed, manifest/profile hashes, and trial evidence. Generated logs and preparation artifacts are Git-ignored.
- `--config` is a complete native configuration and cannot be combined with suite options. Both inputs converge on the same validation and execution entry. `run` defaults to the `paid` label. **`--kind fixture` only labels evidence; it does not turn a real Provider into a free model.**

**Preparation boundary:** the default profile declares preparation plugins. `run` prepares and validates selected tasks before Harbor execution; `prepare` performs the same preparation without model calls. `--task-root` selects the content-addressed cache root. Profiles without preparation declarations and native configurations reference already-prepared tasks; `prepare` requires explicit plugins.

`list` and `check` do not establish container readiness. Readiness checks use Harbor startup, healthcheck, and cleanup operations for the solver and then the separate verifier. Any failure blocks execution. This also applies to native configurations. Checks do not call a model, run grading, or reduce task resource requirements. Each phase is cleaned up afterward. Success establishes single-environment readiness at that time, not future resource availability or concurrent capacity. See Acceptance for the verified scope.

## Free end-to-end fixture

Generate the taskpack, then prepare its Omni images. Use new output directories to preserve earlier evidence.

```bash
benchmark/.venv/bin/python benchmark/tasks/execution-contract/prepare.py \
  --output benchmark/artifacts/contract-source

benchmark/.venv/bin/python -m benchmark.adapters.omni.prepare \
  --task benchmark/artifacts/contract-source/files \
  --output benchmark/artifacts/contract-omni/files

benchmark/.venv/bin/python -m benchmark.adapters.omni.prepare \
  --task benchmark/artifacts/contract-source/patch \
  --output benchmark/artifacts/contract-omni/patch

export OMNI_SMOKE_API_KEY=fixture
benchmark/.venv/bin/python -m benchmark.run check \
  --config benchmark/configs/harbor/smoke.yaml
benchmark/.venv/bin/python -m benchmark.run run \
  --config benchmark/configs/harbor/smoke.yaml --kind fixture
```

`smoke.yaml` runs real Omni against a deterministic local HTTP model, without paid API calls. Harbor Oracle also runs reference controls. Oracle is not evidence of integrating a second real Agent framework.

Image preparation may download dependencies; solver setup injects configuration into prepared images. `preparation.json` records image IDs, source archive and dependency-lock hashes, and the task configuration hash. Model configuration is captured per trial during Agent installation, using the same path for automatic and native runs. Personal configuration, `.env`, and run artifacts are excluded from the source archive.

The fixture model is confined to `tasks/execution-contract/model-server.py`; Omni fixture configuration belongs to `adapters/omni/fixtures/`. Old smoke/isolation-probe tasks and their execution protocols have been removed.

## SWE tasks

The preparer supports `swebench-verified` and `swebench_multilingual` at the pinned upstream revision. The manual preparer requires a SHA-256 image reference. Solver tools remain offline; SWE's separate verifier uses Harbor's public network policy. The adapter isolates model connectivity.

```bash
benchmark/.venv/bin/python -m benchmark.taskpacks.swe.prepare \
  --output-dir benchmark/artifacts/tasks/example \
  --dataset swebench-verified --task-name TASK_ID \
  --image IMAGE_AT_SHA256 \
  --runtime-manifest benchmark/environments/profiles/swe-python.json
```

Task name, dataset, and image are required; no individual task is selected implicitly. Next, use the Omni preparer and reference the resulting task directory in a native configuration. Other Agents integrate through Harbor's native interface; collection and grading remain task-owned.

The current protocol is `isolated-swe-v3`. Derived tasks that do not satisfy its handoff contract must be prepared again; validation does not fall back. The default profile uses the [fixed 50-task suite](suites/swe-verified-mini-hal-50-v1/README.md), with automatic preparation for selected tasks.

## Runtime declarations and deadlines

`environment.workdir` and `environment.env` are the source of truth. `environment/runtime.json` uses version 2:

```json
{
  "version": 2,
  "tools": [
    {
      "name": "project-wrapper",
      "argv_prefix": ["./project-wrapper"],
      "probe_args": ["--version"],
      "description": "Repository-provided toolchain entry"
    }
  ]
}
```

Absent declarations are recorded as undeclared. Healthchecks run as the solver user and do not depend on Agent setup. Each probe has 30 seconds; the healthcheck budget is 30 × tool count + 10 seconds. The probe program itself does not retry; the enclosing healthcheck explicitly sets `retries: 1`, interpreted by Harbor. Declarations express languages, wrappers, and multiple tools without language-name dispatch.

`benchmark.agent_timeout_sec` is the sole job-level Agent budget, defaulting to 1800 seconds. The launcher derives Harbor's outer deadline (+30 seconds) and `BENCHMARK_AGENT_TIMEOUT_SEC`; duplicate overrides are rejected. Solver image builds and Agent setup currently receive 1800 seconds; SWE grading and verifier image builds also receive 1800 seconds. Other taskpacks own their verifier deadlines. Handoff has 120 seconds, including a 60-second collector timeout.

External cancellation is forwarded once to Harbor in its separate process session. The launcher waits up to 150 seconds for native cleanup, then explicitly records unconfirmed cleanup if that expires. The adapter reuses shared process shutdown before collecting cancellation evidence.

## Network boundary

Image preparation may access the network. The solver container uses `network_mode: none` throughout startup, tool execution, collection, and cleanup. After submission sealing, SWE's independent verifier uses Harbor `public` networking for official test resources, not a domain allowlist. Other taskpacks may declare offline verification. The model runs separately using the existing Provider implementation; only that service receives model credentials and Provider configuration.

A single-admission Unix socket session is established before Agent execution. The server removes the listening endpoint before admitting work. Tool children do not inherit the connection and cannot reconnect. Cancellation or disconnection aborts Provider work, with no direct-connection fallback. The boundary does not depend on tool names or command blacklists. In-process extensions remain trusted code.

Preparation implementation hashes invalidate affected caches. Historical readiness evidence does not validate a newer model channel or image.

## Handoff and failure semantics

The solver uses `benchmark-runner`, UID 10001, without sudo or the Docker socket. After Agent execution, shared handoff confirms that UID's processes have stopped, runs the collector as that user, and cleans up collector children. Management-owned `/submission` receives sealed artifacts; `handoff.json` is written last.

A Harbor collect failure does not automatically prevent grading. Verifiers must call shared `validate_submission` to check required artifacts, sizes, and hashes; invalid handoffs produce no reward. Grading assesses task correctness only for valid submissions. A timeout may preserve a submission for grading but must not be reported as natural completion.

The verifier follows the taskpack's network policy and shares neither solver processes, a writable solver workspace, nor model credentials. This is a non-adversarial personal evaluation boundary, not a general malicious-agent defense.

## Evidence for each run

```text
benchmark/jobs/<job>/
├── invocation.json                 Pre-run registration and launcher lifecycle
├── launch-config.yaml              Effective Harbor configuration
├── launcher.log
├── analysis-index.json             Rebuildable v2 index
└── <trial>/
    ├── result.json                 Native Harbor result
    ├── agent/                      Native logs and adapter evidence
    ├── artifacts/
    │   ├── benchmark-audit/        Probes, collector execution, and handoff audit
    │   └── submission/             Sealed artifacts and completion receipt
    └── verifier/                   Grading output or explicit failure
```

Adapters publish version-1 references through `AgentContext.metadata.benchmark_evidence`, with `kind`, trial-relative `path`, `media_type`, and `producer`. The shared index checks path boundaries, existence, size, and hash. Omni interprets its own Trace; the shared launcher does not hardcode its native directories.

`verifier_artifacts` indexes files under the verifier directory without interpreting taskpack formats. SWE's `error.json` records version, stage, original exception, and available command/exit-code details. Stages distinguish asset checks, workspace checks, patch application, execution, report parsing, and publication. A stage locates the failure; it does not assign responsibility. Native scores and Harbor exceptions remain unchanged.

The index reconciles frozen selection and configuration with native results for each task × Agent configuration. It distinguishes missing, duplicate, execution-failed, unscored, and scored trials; a valid zero is scored. Missing selection evidence yields `unknown`; preparation-only jobs are `not_applicable`. `runs` lists task IDs, Agent configuration hashes, and states. Different Agents or models are separate execution items. Launcher exit 0 does not prove completion; inspect `completion` and native results. Invalid native results publish no score or cost facts. Invalid supplementary evidence does not erase a valid native score.

File existence does not prove Trace completeness, and Trace completeness does not prove task success. Missing, invalid, absent, and incomplete evidence remain distinct. Unknown cost is not zero; last-turn token usage is not a full-task bill. Failed and timed-out runs retain retrievable artifacts and explicitly record missing evidence.

```bash
benchmark/.venv/bin/python -m benchmark.run index benchmark/jobs/JOB
benchmark/.venv/bin/python -m benchmark.run report benchmark/jobs/JOB
```

`benchmark/jobs/` and `benchmark/artifacts/` are Git-ignored. Do not paste full traces, credentials, or raw model requests into tracked reports.

## Acceptance

```bash
benchmark/.venv/bin/python -m unittest discover -s benchmark/tests -v
BENCHMARK_TEST_IMAGE=PREPARED_IMAGE_ID \
  benchmark/.venv/bin/python -m unittest benchmark.tests.test_collection -v
```

Container tests cover residual processes, collection failures, submission validation, and network/filesystem boundaries. They explicitly skip when required images are absent. Official SWE verifier tests require `OMNI_TEST_VERIFIER_IMAGE`.

The fixed 50 tasks completed image builds and official empty-patch 0/reference-patch 1 controls on 2026-10-04. This is not an Agent pass rate. Free fixtures cover concurrency, cancellation, and isolation lifecycle. Two-phase readiness passed real-container fixture validation, including initial builds and cache reuse. Single-trial isolated model execution and a credential variable colliding with a process-environment name were also validated on 2026-10-08. This does not establish a fresh validation of all 50 tasks on the latest version. Real-Provider five-way concurrency and long-term stability remain unverified. The current scope is internal evaluation, not leaderboard equivalence, complete multilingual coverage, or adversarial multi-tenant security.

Evidence is retained per job in ignored directories. Implementation plans, individual diagnostics, and machine operations history are not runtime configuration or additional contracts. Evidence is tied to source/image versions.

`test_public_verifier_starts_after_sealed_solver_stops` checks write rejection after sealing, Docker stop/start order, handoff hashes, and verifier public networking. It requires verifier access to example.com and does not use a paid Provider. Current network validation uses `tasks/execution-contract/probe-network.py` and lifecycle tests; the old allowlist probes were removed.

### Agent deadline versus cleanup watchdog

The Omni adapter supplies generic headless `--deadline-at-ms`, calculated from the container clock at process launch. It covers Agent startup and execution and is not reset for model requests or recovery. `cleanup_grace_sec`, default 10, reserves shutdown time before the process watchdog without increasing the Run budget. TERM/KILL is the last resort. Cooperatively cancelled runs retain outcomes and Trace even when Harbor reports a nonzero process exit. The adapter neither decides Agent completion nor recovers model responses.

### Native output evidence

Omni's native state archive includes Session output manifests and sanitized bodies. After collection, the adapter writes `output-summary.json` and checks body sizes/hashes and transcript reference closure. Capture completeness and archive integrity are independent: interrupted capture can be archived intact; a missing body makes the archive incomplete without rewriting the score. Local evidence stays under ignored `benchmark/artifacts/`.

### Automatic preparation and caching

The default profile declares `preparation.taskpack` and `preparation.adapter`. One `tracked_run` lifecycle manages selection, preparation, validation, and execution.

```bash
# Free: prepare and validate images without model calls
pnpm run benchmark prepare --first 3 --jobs-dir /path/shared-with-docker/jobs
# Paid: the same preparation followed by Harbor execution
pnpm run benchmark run --profile benchmark/configs/omni.local.json --first 3 --concurrency 3 --jobs-dir /path/shared-with-docker/jobs
```

Configure the Docker context and export required credentials before real runs. The shared entry does not parse `.env`, guess sockets, or start Docker. The Omni adapter delegates selected credential resolution to Models. `prepare` needs neither model configuration nor credentials; real `run` checks configuration before preparation. Build and healthcheck containers receive no model credentials. `check` validates configuration/plugin declarations, not readiness.

Preparation plugins are trusted local Python code explicitly selected by `entrypoint=module:Class`; the shared layer does not dispatch on task, language, or Agent names.

- Taskpacks receive options, the profile directory, and manifest. `resolve(task, requirements)` returns pinned inputs; `prepare(task, output, resolved)` invokes the task preparer.
- Adapters receive options, the profile directory, and execution configuration. `snapshot(work)` captures build inputs and returns `identity`, `requirements`, and private build information. `prepare(task, output, snapshot)` packages the Agent into the Harbor task contract. Omni captures runtime model configuration separately at trial installation; shared preparation code does not interpret it or credentials.
- Plugin entrypoint source and repository preparation code participate in cache identity. External dependencies, templates, files, and versions must enter the plugin's `resolve` result or `snapshot.identity`; undeclared mutable inputs are unsupported.
- Taskpacks, upstream Dockerfiles, and runtime declarations own dependencies. Healthchecks verify declared probes, not arbitrary software or business tests.

Caches use `task_root/<task-id>/<input-digest>/<task-id>`. Keys include fixed task inputs, Agent source content, preparation code, and dependency locks. Deterministic archive metadata avoids invalidation from mtime alone. A per-key lock serializes publication. Entries are published only after builds, healthchecks, and file hashing. Failed builds stay under the job and are not cache entries. Corrupt cache contents fail explicitly; missing local images trigger rebuilding and preservation of the expired cache under the job. Cache hits still check image existence and health.

`invocation.json` records preparation from the start. `preparation/preflight.log` and per-task `prepare.log` preserve build logs; `readiness/environment.log` and `readiness/artifacts/` preserve Harbor checks and probes. Preparation failure prevents Agent execution and model calls. Preparation is sequential; `--concurrency` controls Harbor trials only. Changed inputs create new images without overwriting old jobs or evidence. Profiles without preparation and native configurations explicitly use pre-prepared tasks, not an implicit fallback.

## SWE build dependencies and grading controls

Upstream tasks provide repository versions, images, and tests. Preparation composes isolated containers and reuses image layers rather than maintaining handwritten per-task environments.

`build_dependencies_manifest` declares Python interpreter/project paths inside the container. The default Verified profile uses `taskpacks/swe/profiles/python-build.json`. During builds, the provisioner reads `build-system.requires` from project `pyproject.toml`, downloads compatible wheels using the declared interpreter, and records metadata, requirements, and wheel SHA-256. This belongs to the SWE verifier; the shared preparation layer and Agent do not parse Python dependencies.

Online warmup uses the official grading commands. Local wheels and `PIP_NO_INDEX=1` preserve pip build isolation afterward. Official tests may access public resources during image validation and runtime grading. Before publishing the image, the same grading entry must return 0 for an empty patch and 1 for the reference patch, then restore the initial repository baseline. `/tests/control-validation.json` records the controls. Any failed control blocks publication and paid solving.

The control mechanism applies across languages supported by the SWE taskpack. Python wheel preparation covers explicit project requirements, not arbitrary ecosystem dependencies. Missing wheels, dynamic requirements, or unprepared dependencies must surface as failures; do not skip tests or hide failures to claim readiness. New tasks require their own preparation and validation.

The manual SWE preparer accepts:

```bash
--build-dependencies-manifest benchmark/taskpacks/swe/profiles/python-build.json
```

Preparation code and fixed build-input changes invalidate caches; changing only the model configuration does not. Historical jobs, patches, and scores remain unchanged.

## Internal operation and maintenance

Environment readiness, Agent completion, and task success are separate facts. `invocation.json` records launcher lifecycle; `analysis-index.json` summarizes trials. Interpret scores alongside `exception_info` and `verifier_result`. Harbor exit 0 does not mean every task succeeded, and grading errors are not valid zero scores.

Before batches, inspect both host and daemon storage. Remote/Colima space may be much smaller than host space. `docker system df` reports usage, not filesystem free space. Concurrency is a scheduling ceiling, not a CPU, memory, or disk guarantee. Sequential preparation stops on the first failure; unprepared tasks have no failure score. For a complete readiness inventory, invoke the same `prepare --task` entry per task and retain each job.

Logs and caches have no automatic expiry or deletion. Operators must:

- Retain configuration, native Trace, outputs, submissions, and grading evidence; link analysis to originals.
- Confirm process shutdown and container cleanup and archive needed evidence before deletion. Choose retention locally.
- Distinguish caches, Docker images, and jobs. Delete only identified, unused assets; do not use global `docker system prune` as normal operation or automatic recovery.
- Preserve failed build directories; let preparation rebuild missing images instead of fabricating receipts.
- Check invocation, exceptions, Trace integrity, and container state after interruption. An explicit rerun creates a new job; there is no automatic paid retry or guaranteed resume.

Free container lifecycle tests live in `tests/test_lifecycle_containers.py`. First set `BENCHMARK_PREPARATION_TEST_ROOT` to a new Docker-shared directory and prepare the files fixture:

```bash
benchmark/.venv/bin/python -m unittest benchmark.tests.test_preparation.ContainerPreparationTest -v
```

Then set `BENCHMARK_LIFECYCLE_TASK` to the prepared task path and `BENCHMARK_LIFECYCLE_ROOT` to a new Docker-shared evidence directory:

```bash
benchmark/.venv/bin/python -m unittest benchmark.tests.test_lifecycle_containers -v
```

These tests use the deterministic fixture model and cover concurrency 5, HTTP errors, disconnection, timeout, external cancellation, and container loss. Fault injection stays in the test service. Tests do not read real Provider keys or establish real throughput, rate-limit behavior, adversarial isolation, or model task-solving ability. They stop their own fault-scenario containers.

## Capacity observations

`prepare`/`run` capture capacity before preparation and after preparation/before execution, record it in `invocation.json.capacity`, and print a summary. Observations cover host job/cache filesystems, the Docker root filesystem visible from an existing selected task image, task count, and concurrency. Do not add capacities of shared filesystems; container root capacity does not describe every mounted volume.

Required capacity and sufficiency remain unknown. The entry does not estimate demand from task count, reject runs by a heuristic, change concurrency, or delete assets. On a cold start without local task images, Docker space is unknown; no extra probe image is pulled. Capacity is observed again after preparation.
