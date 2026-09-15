"""Tracked benchmark invocation; Harbor and native Omni Trace own execution facts."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def index_job(job):
    """Rebuild references from disk, including incomplete attempts; never invent Trace."""
    job = Path(job).resolve()
    trials = []
    for trial in sorted(job.iterdir()) if job.is_dir() else []:
        if not trial.is_dir():
            continue
        files = {}
        for name, relative in {
            "harbor_result": "result.json",
            "process_exit": "agent/process-exit.json",
            "source": "agent/setup/source.json",
            "input": "agent/instruction-manifest.json",
            "omni_result": "agent/omni/result.json",
            "shutdown": "agent/omni/stderr.log",
            "submission": "agent/omni/changes.patch",
            "verifier_output": "verifier/test-stdout.txt",
            "reward": "verifier/reward.txt",
        }.items():
            path = trial / relative
            item = {"path": str(path.relative_to(job)), "state": "missing"}
            if path.is_file():
                item["state"] = "present"
                item["bytes"] = path.stat().st_size
                if path.suffix == ".json":
                    try:
                        value = json.loads(path.read_text())
                        if not isinstance(value, dict):
                            raise ValueError("Expected JSON object")
                    except (ValueError, UnicodeError):
                        item["state"] = "invalid"
            files[name] = item
        traces = []
        for manifest in sorted(
            trial.glob("agent/omni/state/traces/*/*/*/manifest.json")
        ):
            replay = manifest.with_name("replay.jsonl")
            trace = {
                "manifest": str(manifest.relative_to(job)),
                "replay": str(replay.relative_to(job)),
                "state": "incomplete",
            }
            try:
                metadata = json.loads(manifest.read_text())
                trace.update(
                    session_id=metadata.get("sessionId"),
                    run_id=metadata.get("runId"),
                    status=metadata.get("status"),
                )
                count = 0
                last_kind = None
                contiguous = True
                with replay.open() as stream:
                    for line in stream:
                        event = json.loads(line)
                        count += 1
                        contiguous &= event.get("seq") == count
                        last_kind = event.get("kind")
                trace.update(events=count, contiguous=contiguous, last_event=last_kind)
                capture = (metadata.get("summary") or {}).get("capture") or {}
                if capture.get("degraded"):
                    trace["state"] = "degraded"
                elif (
                    count
                    and contiguous
                    and metadata.get("completedAt") is not None
                    and last_kind is not None
                    and last_kind
                    == {
                        "completed": "run.completed",
                        "cancelled": "run.cancelled",
                        "error": "run.failed",
                    }.get(metadata.get("status"))
                ):
                    trace["state"] = "complete"
            except FileNotFoundError:
                pass
            except (ValueError, UnicodeError, AttributeError):
                trace["state"] = "invalid"
            traces.append(trace)
        trials.append({"trial": trial.name, "artifacts": files, "traces": traces})
    result = {"version": 1, "indexed_at": timestamp(), "trials": trials}
    # Index is derived; raw artifacts remain the source of truth.
    job.mkdir(parents=True, exist_ok=True)
    write_json(job / "analysis-index.json", result)
    return result


def tracked_run(config, jobs_dir, kind):
    config = Path(config).resolve()
    config_bytes = config.read_bytes()
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
    write_json(job / "invocation.json", record)
    print(f"Benchmark artifacts: {job}", flush=True)
    try:
        with (job / "launcher.log").open("w") as log:
            environment = os.environ.copy()
            environment["PYTHONPATH"] = (
                str(ROOT) + os.pathsep + environment.get("PYTHONPATH", "")
            )
            process = subprocess.run(
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
            )
        record.update(state="exited", exit_code=process.returncode)
        return process.returncode
    except BaseException as error:
        # This describes the launcher only, not proof of container cleanup.
        record.update(state="interrupted", error_type=type(error).__name__)
        raise
    finally:
        record["finished_at"] = timestamp()
        write_json(job / "invocation.json", record)
        index_job(job)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    run = sub.add_parser("run")
    run.add_argument("--config", type=Path, required=True)
    run.add_argument("--jobs-dir", type=Path, default=ROOT / "benchmark/jobs")
    run.add_argument(
        "--kind",
        choices=["paid", "fixture"],
        required=True,
        help="Declared model invocation kind; not proof of billing",
    )
    inspect = sub.add_parser("index")
    inspect.add_argument("job", type=Path)
    args = parser.parse_args()
    if args.action == "run":
        return tracked_run(args.config, args.jobs_dir, args.kind)
    if not args.job.is_dir():
        parser.error("job directory does not exist")
    index_job(args.job)
    print(args.job.resolve() / "analysis-index.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
