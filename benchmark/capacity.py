"""Observational capacity snapshots; no admission thresholds, pulls or cleanup policy."""

import json
import shutil
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

from harbor.models.task.config import TaskConfig

ROOT = Path(__file__).resolve().parents[1]


def host_capacity(path):
    requested = Path(path).resolve()
    existing = requested
    while not existing.exists():
        existing = existing.parent
    try:
        usage = shutil.disk_usage(existing)
        return {
            "state": "available",
            "path": str(requested),
            "measured_path": str(existing),
            "total_bytes": usage.total,
            "used_bytes": usage.used,
            "available_bytes": usage.free,
        }
    except OSError as error:
        return {
            "state": "unknown",
            "path": str(requested),
            "reason": type(error).__name__,
        }


def local_task_image(config, selection):
    paths = [Path(task["path"]) / "task.toml" for task in config.get("tasks", [])]
    if selection and "task_root" in selection:
        root = Path(selection["task_root"])
        for task_id in selection["task_ids"]:
            paths.extend(
                path
                for path in sorted((root / task_id).glob("*/" + task_id + "/task.toml"))
                if not path.parent.parent.name.startswith(".")
                and (path.parent.parent / "receipt.json").is_file()
            )
    for path in paths:
        path = path if path.is_absolute() else ROOT / path
        try:
            task = TaskConfig.model_validate_toml(path.read_text())
            image = task.environment.docker_image
            if not image or not image.startswith("sha256:"):
                continue
            result = subprocess.run(
                ["docker", "image", "inspect", image], capture_output=True, timeout=10
            )
            if result.returncode == 0:
                return image
        except (OSError, ValueError, subprocess.TimeoutExpired):
            continue
    return None


def docker_capacity(config, selection):
    result = {"state": "unknown", "scope": "probe_container_root_filesystem"}
    name = "benchmark-capacity-" + uuid.uuid4().hex
    started = False
    try:
        info = json.loads(
            subprocess.check_output(
                ["docker", "info", "--format", "{{json .}}"],
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
        )
        result.update(
            driver=info.get("Driver"),
            docker_root=info.get("DockerRootDir"),
            cpus=info.get("NCPU"),
            memory_bytes=info.get("MemTotal"),
        )
        image = local_task_image(config, selection)
        if image is None:
            result["reason"] = "no_local_selected_task_image"
            return result
        result["image"] = image
        result["probe_container"] = name
        started = True
        probe = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--name",
                name,
                "--pull",
                "never",
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
                "df",
                image,
                "-Pk",
                "/",
            ],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if probe.returncode:
            result.update(reason="filesystem_probe_failed", exit_code=probe.returncode)
            return result
        fields = probe.stdout.strip().splitlines()[-1].split()
        total, used, available = (int(value) * 1024 for value in fields[-5:-2])
        if min(total, used, available) < 0 or not total or available > total:
            raise ValueError("Invalid filesystem capacity")
        result.update(
            state="available",
            total_bytes=total,
            used_bytes=used,
            available_bytes=available,
            filesystem=fields[0],
        )
    except (OSError, ValueError, IndexError, subprocess.SubprocessError) as error:
        result.update(state="unknown", reason=type(error).__name__)
    finally:
        if started:
            try:
                subprocess.run(
                    ["docker", "rm", "--force", name], capture_output=True, timeout=10
                )
                # --rm normally already removed it; verify absence instead of interpreting stderr.
                remaining = subprocess.run(
                    [
                        "docker",
                        "ps",
                        "-a",
                        "--filter",
                        "name=" + name,
                        "--format",
                        "{{.Names}}",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                result["cleanup"] = (
                    "verified"
                    if remaining.returncode == 0 and not remaining.stdout.strip()
                    else "unconfirmed"
                )
            except (OSError, subprocess.SubprocessError):
                result["cleanup"] = "unconfirmed"
    return result


def capture_capacity(job, config, selection, phase):
    paths = {"jobs": job}
    if selection and selection.get("task_root"):
        paths["task_cache"] = selection["task_root"]
    snapshot = {
        "version": 1,
        "phase": phase,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "selected_tasks": len(selection["task_ids"])
        if selection
        else len(config.get("tasks", [])),
        "trial_concurrency": config.get("n_concurrent_trials", 1),
        "required_bytes": None,
        "capacity_sufficient": None,
        "expectation": "Demand is unknown; shared layers, build temporaries and outputs are not estimated. Filesystem capacities must not be summed.",
        "host": {name: host_capacity(path) for name, path in paths.items()},
        "docker": docker_capacity(config, selection),
    }

    def display(value):
        return (
            f"{value['available_bytes'] / 1024**3:.2f} GiB free"
            if value["state"] == "available"
            else "unknown (" + value["reason"] + ")"
        )

    print(
        f"Capacity [{phase}]: host {display(snapshot['host']['jobs'])}; Docker root filesystem {display(snapshot['docker'])}; tasks={snapshot['selected_tasks']}, concurrency={snapshot['trial_concurrency']}; required space/sufficiency unknown",
        flush=True,
    )
    return snapshot
