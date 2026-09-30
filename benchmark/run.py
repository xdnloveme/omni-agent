"""Tracked benchmark invocation; Harbor and adapters own execution facts."""

import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def evidence_file(trial, relative):
    """Use the shared artifact boundary; format interpretation stays with its producer."""
    from benchmark.environments.handoff import file_info

    item = {"path": relative, "state": "missing"}
    try:
        info = file_info(trial, relative)
        item.update(state="present", bytes=info["size"], sha256=info["sha256"])
    except FileNotFoundError:
        pass
    except (ValueError, OSError):
        item["state"] = "invalid"
    return item


def index_job(job):
    job = Path(job).resolve()
    trials = []
    for trial in sorted(job.iterdir()) if job.is_dir() else []:
        if (
            not trial.is_dir()
            or trial.name.startswith(".")
            or trial.name == "preparation"
        ):
            continue
        files = {
            name: evidence_file(trial, relative)
            for name, relative in {
                "harbor_result": "result.json",
                "runtime_probes": "artifacts/benchmark-audit/runtime-probes.jsonl",
                "handoff": "artifacts/submission/handoff.json",
                "handoff_audit": "artifacts/benchmark-audit/handoff.jsonl",
                "verifier_output": "verifier/test-stdout.txt",
                "reward": "verifier/reward.txt",
            }.items()
        }
        indexed_files = {item["path"]: item for item in files.values()}
        references = []
        state = "not_provided"
        native = {}
        try:
            native = json.loads((trial / "result.json").read_text())
            if not isinstance(native, dict):
                native = {}
                raise ValueError("Harbor result must be an object")
            declaration = (
                (native.get("agent_result") or {}).get("metadata") or {}
            ).get("benchmark_evidence")
            if declaration is not None:
                if declaration.get("version") != 1 or not isinstance(
                    declaration.get("items"), list
                ):
                    raise ValueError("Invalid evidence declaration")
                for entry in declaration["items"]:
                    if set(entry) != {
                        "kind",
                        "path",
                        "media_type",
                        "producer",
                    } or not all(isinstance(v, str) for v in entry.values()):
                        raise ValueError("Invalid evidence reference")
                    references.append({**entry, **evidence_file(trial, entry["path"])})
                state = "provided"
        except FileNotFoundError:
            pass
        except (ValueError, TypeError, AttributeError):
            state = "invalid"
            files["harbor_result"]["state"] = "invalid"
        agent_context = native.get("agent_result")
        if not isinstance(agent_context, dict):
            agent_context = {}
        trials.append(
            {
                "trial": trial.name,
                "artifacts": files,
                # Taskpacks own file formats and diagnostic semantics. Index every
                # verifier artifact without interpreting task-specific contents.
                "verifier_artifacts": [
                    indexed_files.get(str(path.relative_to(trial)))
                    or evidence_file(trial, str(path.relative_to(trial)))
                    for path in sorted((trial / "verifier").rglob("*"))
                    if path.is_file() or path.is_symlink()
                ],
                "evidence_state": state,
                "evidence": references,
                "exception": native.get("exception_info"),
                "score": native.get("verifier_result"),
                "cost_usd": agent_context.get("cost_usd"),
                "agent_context": agent_context,
                "timings": {
                    key: native.get(key)
                    for key in (
                        "environment_setup",
                        "agent_setup",
                        "agent_execution",
                        "verifier",
                    )
                },
            }
        )
    result = {"version": 2, "indexed_at": timestamp(), "trials": trials}
    job.mkdir(parents=True, exist_ok=True)
    write_json(job / "analysis-index.json", result)
    return result


def check_config(config, *, validate_tasks=True):
    import yaml
    from harbor.models.job.config import JobConfig
    from harbor.models.task.config import TaskConfig

    value = yaml.safe_load(Path(config).read_text())
    budget = value.pop("benchmark", {}).get("agent_timeout_sec", 1800)
    if not isinstance(budget, int) or not 1 <= budget <= 1800:
        raise ValueError("Agent budget must be between 1 and 1800 seconds")
    # Default conservatively; Harbor is the only concurrency owner.
    value.setdefault("n_concurrent_trials", 1)
    concurrency = value["n_concurrent_trials"]
    if type(concurrency) is not int or concurrency < 1:
        raise ValueError("Concurrency must be a positive integer")
    for agent in value.get("agents", []):
        # kwargs are opaque to the common runner. The adapter receives Harbor's deadline.
        if "override_timeout_sec" in agent:
            raise ValueError(
                "Declare benchmark.agent_timeout_sec only; outer deadline is derived"
            )
        agent["override_timeout_sec"] = budget + 30
        if "BENCHMARK_AGENT_TIMEOUT_SEC" in agent.get("env", {}):
            raise ValueError(
                "Agent budget is generated from benchmark.agent_timeout_sec"
            )
        agent.setdefault("env", {})["BENCHMARK_AGENT_TIMEOUT_SEC"] = str(budget)
        agent["override_setup_timeout_sec"] = 1800
    for task in value.get("tasks", []) if validate_tasks else []:
        path = Path(task["path"])
        if not path.is_absolute():
            path = ROOT / path
        contract = TaskConfig.model_validate_toml((path / "task.toml").read_text())
        if (
            contract.agent.user != "benchmark-runner"
            or contract.verifier.environment_mode != "separate"
            or not contract.verifier.collect
        ):
            raise ValueError(
                "Task is not prepared for the execution/handoff contract: " + str(path)
            )
    resolved = JobConfig.model_validate(value)
    if resolved.n_attempts != 1 or resolved.retry.max_retries != 0:
        raise ValueError("This contract requires one attempt per task and no retries")
    return value


def verify_log_mount(job, config):
    """Harbor's mounted logs require the daemon to see the host's actual directory."""
    from harbor.models.task.config import TaskConfig

    task_path = Path(config["tasks"][0]["path"])
    if not task_path.is_absolute():
        task_path = ROOT / task_path
    task = TaskConfig.model_validate_toml((task_path / "task.toml").read_text())
    image = task.environment.docker_image
    if not image or "," in str(job):
        raise ValueError(
            "Prepare an immutable task image and a Docker-shareable job directory first"
        )
    identity = uuid.uuid4().hex
    sentinel = job / ("mount-check-" + identity)
    sentinel.write_text(identity)
    name = "benchmark-mount-check-" + identity
    try:
        result = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--name",
                name,
                "--platform",
                "linux/amd64",
                "--network",
                "none",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--entrypoint",
                "cat",
                "--mount",
                f"type=bind,source={job},target=/benchmark-check,readonly",
                image,
                "/benchmark-check/" + sentinel.name,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode or result.stdout != identity:
            raise RuntimeError(
                "Docker daemon cannot read this job directory; choose --jobs-dir under a daemon-shared directory"
            )
    finally:
        sentinel.unlink(missing_ok=True)
        subprocess.run(
            ["docker", "rm", "--force", name], capture_output=True, timeout=30
        )


def tracked_run(config, jobs_dir, kind, selection=None, *, prepare_only=False):
    config = Path(config).resolve()
    import yaml

    if prepare_only and not (selection and "preparation" in selection):
        raise ValueError("prepare requires a suite profile with preparation plugins")
    compiled = yaml.safe_load(config.read_text())
    config_bytes = yaml.safe_dump(compiled, sort_keys=False).encode()
    name = (
        datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        + "-"
        + uuid.uuid4().hex[:12]
    )
    job = Path(jobs_dir).resolve() / name
    job.mkdir(parents=True, exist_ok=False)
    snapshot = job / "launch-config.yaml"
    snapshot.write_bytes(config_bytes)
    record = {
        "version": 1,
        "id": name,
        "kind": kind,
        "state": "running",
        "started_at": timestamp(),
        "config_path": str(config),
        "config_snapshot": snapshot.name,
        "config_sha256": hashlib.sha256(config_bytes).hexdigest(),
        "cost_status": "unknown",
        "analysis_index": "analysis-index.json",
    }
    if selection is not None:
        record["selection"] = selection
    write_json(job / "invocation.json", record)
    print(f"Benchmark artifacts: {job}", flush=True)
    try:
        record["stage"] = "configuration"
        write_json(job / "invocation.json", record)
        check_config(snapshot, validate_tasks=False)
        from benchmark.capacity import capture_capacity

        record["capacity"] = [
            capture_capacity(job, compiled, selection, "before_preparation")
        ]
        write_json(job / "invocation.json", record)
        if selection and "preparation" in selection:
            from benchmark.preparation import prepare_selected

            record["stage"] = "preparation"
            write_json(job / "invocation.json", record)
            compiled = prepare_selected(
                compiled,
                selection,
                job,
                record,
                lambda: write_json(job / "invocation.json", record),
            )
            snapshot.write_text(yaml.safe_dump(compiled, sort_keys=False))
        compiled = check_config(snapshot)
        config_bytes = yaml.safe_dump(compiled, sort_keys=False).encode()
        snapshot.write_bytes(config_bytes)
        record["config_sha256"] = hashlib.sha256(config_bytes).hexdigest()
        record["stage"] = "preflight"
        record["preparations"] = []
        for task in compiled.get("tasks", []):
            path = Path(task["path"])
            if not path.is_absolute():
                path = ROOT / path
            manifest = path / "preparation.json"
            record["preparations"].append(
                {
                    "task": str(path),
                    "manifest": json.loads(manifest.read_text())
                    if manifest.exists()
                    else None,
                }
            )
        write_json(job / "invocation.json", record)
        record["capacity"].append(
            capture_capacity(
                job,
                compiled,
                selection,
                "after_preparation" if prepare_only else "before_execution",
            )
        )
        write_json(job / "invocation.json", record)
        verify_log_mount(job, compiled)
        if prepare_only:
            record.update(state="prepared", exit_code=0)
            return 0
        record["stage"] = "harbor"
        write_json(job / "invocation.json", record)
        with (job / "launcher.log").open("w") as log:
            environment = os.environ.copy()
            environment["PYTHONPATH"] = (
                str(ROOT) + os.pathsep + environment.get("PYTHONPATH", "")
            )
            process = subprocess.Popen(
                [
                    str(Path(sys.executable).with_name("harbor")),
                    "run",
                    "-c",
                    str(snapshot),
                    "--job-name",
                    name,
                    "--jobs-dir",
                    str(job.parent),
                ],
                cwd=ROOT,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            try:
                process.wait()
            except KeyboardInterrupt:
                # Forward once to Harbor; subprocess.run would kill it before recovery.
                record["cancel_requested_at"] = timestamp()
                if process.poll() is None:
                    process.send_signal(signal.SIGINT)
                try:
                    process.wait(timeout=150)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    record["cleanup_status"] = "unconfirmed"
                    raise RuntimeError(
                        "Harbor did not finish cancellation cleanup within 150 seconds"
                    )
                record.update(
                    state="cancelled",
                    exit_code=process.returncode,
                    cleanup_status="harbor_exited",
                )
                return 130
        record.update(state="exited", exit_code=process.returncode)
        return process.returncode
    except BaseException as error:
        if record.get("preparation", {}).get("state") == "running":
            record["preparation"]["state"] = "failed"
            for task in record["preparation"]["tasks"]:
                if task["state"] != "ready":
                    task["state"] = "failed"
        # This describes the launcher only, not proof of container cleanup.
        record.update(
            state="interrupted" if isinstance(error, KeyboardInterrupt) else "failed",
            error_type=type(error).__name__,
            error=str(error),
        )
        raise
    finally:
        record["finished_at"] = timestamp()
        write_json(job / "invocation.json", record)
        index_job(job)


def request_cancel(signum, frame):
    raise KeyboardInterrupt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    run = sub.add_parser("run")
    run.add_argument("--jobs-dir", type=Path, default=ROOT / "benchmark/jobs")
    run.add_argument(
        "--kind",
        choices=["paid", "fixture"],
        default="paid",
        help="Declared model invocation kind (default: paid); not proof of billing",
    )
    prepare = sub.add_parser(
        "prepare",
        help="Prepare and validate selected environments without model execution",
    )
    prepare.add_argument("--jobs-dir", type=Path, default=ROOT / "benchmark/jobs")
    check = sub.add_parser("check")
    listing = sub.add_parser(
        "list", help="Preview selection without preparing or running tasks"
    )
    from benchmark.selection import add_selection_arguments, compile_selection

    for command in (run, prepare, check, listing):
        add_selection_arguments(command)
    report = sub.add_parser("report")
    report.add_argument("job", type=Path)
    inspect = sub.add_parser("index")
    inspect.add_argument("job", type=Path)
    args = parser.parse_args()
    if args.action in {"run", "prepare", "check", "list"}:
        try:
            config, selection = compile_selection(args)
            if selection is not None:
                print(json.dumps(selection, indent=2, ensure_ascii=False), flush=True)
            if args.action == "list":
                return 0
            # Only configuration translation lives here; all runs use tracked_run.
            with tempfile.TemporaryDirectory(prefix="omni-benchmark-") as directory:
                if isinstance(config, dict):
                    import yaml

                    path = Path(directory) / "selected.yaml"
                    path.write_text(yaml.safe_dump(config, sort_keys=False))
                else:
                    path = config
                if args.action == "check":
                    if selection and "preparation" in selection:
                        # Source declarations are validated without pretending that images are ready.
                        from benchmark.preparation import load_plugin

                        declaration = selection["preparation"]
                        if set(declaration) != {"taskpack", "adapter"}:
                            raise ValueError(
                                "Preparation requires taskpack and adapter"
                            )
                        profile_dir = Path(selection["profile_path"]).parent
                        load_plugin(
                            declaration["taskpack"],
                            profile_dir,
                            json.loads(Path(selection["manifest_path"]).read_text()),
                        )
                        load_plugin(declaration["adapter"], profile_dir, config)
                        value = dict(config)
                        value.pop("tasks", None)
                        path.write_text(yaml.safe_dump(value))
                    check_config(path)
                    print(
                        "Configuration valid (no model or Docker execution; preparation and readiness are not verified)"
                    )
                    return 0
                previous = signal.signal(signal.SIGTERM, request_cancel)
                try:
                    if args.action == "prepare":
                        return tracked_run(
                            path,
                            args.jobs_dir,
                            "preparation",
                            selection,
                            prepare_only=True,
                        )
                    return tracked_run(path, args.jobs_dir, args.kind, selection)
                finally:
                    signal.signal(signal.SIGTERM, previous)
        except (ValueError, OSError) as error:
            parser.error(str(error))
    if not args.job.is_dir():
        parser.error("job directory does not exist")
    result = index_job(args.job)
    if args.action == "report":
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    print(args.job.resolve() / "analysis-index.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
