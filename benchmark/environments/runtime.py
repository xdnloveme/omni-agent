"""Task readiness probes. This file also runs in prepared images using stdlib only."""

import argparse
import json
import os
import pwd
import re
import subprocess
import sys
import time
from pathlib import Path


def validate_runtime(value):
    if (
        not isinstance(value, dict)
        or set(value) != {"version", "tools"}
        or value["version"] != 2
    ):
        raise ValueError("Expected runtime declaration version 2")
    tools = value["tools"]
    if not isinstance(tools, list) or len(tools) > 16:
        raise ValueError("Expected at most 16 runtime tools")
    names = set()
    for tool in tools:
        if not isinstance(tool, dict) or set(tool) != {
            "name",
            "argv_prefix",
            "probe_args",
            "description",
        }:
            raise ValueError("Invalid runtime tool fields")
        if (
            not isinstance(tool["name"], str)
            or not re.fullmatch(r"[a-z][a-z0-9_-]*", tool["name"])
            or tool["name"] in names
        ):
            raise ValueError("Runtime tool names must be nonempty and unique")
        names.add(tool["name"])
        if not isinstance(tool["description"], str):
            raise ValueError("Expected tool description")
        for key in ("argv_prefix", "probe_args"):
            args = tool[key]
            if (
                not isinstance(args, list)
                or not args
                or len(args) > 16
                or any(
                    not isinstance(arg, str) or not arg or "\0" in arg for arg in args
                )
            ):
                raise ValueError("Expected nonempty argument arrays")
    return value


def read_task_runtime(environment_dir):
    path = Path(environment_dir) / "runtime.json"
    return validate_runtime(json.loads(path.read_text())) if path.exists() else None


def probe(declaration, *, cwd, user, audit_dir):
    audit_dir = Path(audit_dir)
    audit_dir.mkdir(parents=True, exist_ok=True)
    account = pwd.getpwnam(user)
    # Inherit Harbor's task environment, not the management user's HOME.
    env = {**os.environ, "HOME": account.pw_dir}
    observations = []
    with (audit_dir / "runtime-probes.jsonl").open("x", encoding="utf-8") as audit:

        def record(event, **details):
            audit.write(
                json.dumps({"timestamp": time.time(), "event": event, **details}) + "\n"
            )
            audit.flush()

        record(
            "started", cwd=cwd, user=user, uid=account.pw_uid, declaration=declaration
        )
        try:
            for tool in (declaration or {}).get("tools", []):
                argv = [*tool["argv_prefix"], *tool["probe_args"]]
                record("probe_started", tool=tool["name"], argv=argv)
                command = (
                    ["runuser", "--user", user, "--preserve-environment", "--", *argv]
                    if os.geteuid() == 0
                    else argv
                )
                if os.geteuid() not in (0, account.pw_uid):
                    raise PermissionError("Probe identity differs from solver identity")
                # Output is captured to files so a timeout still leaves partial observations.
                out = audit_dir / (tool["name"].replace("/", "_") + ".stdout")
                err = audit_dir / (tool["name"].replace("/", "_") + ".stderr")
                with out.open("xb") as stdout, err.open("xb") as stderr:
                    process = subprocess.run(
                        command,
                        cwd=cwd,
                        env=env,
                        stdout=stdout,
                        stderr=stderr,
                        timeout=30,
                    )
                observation = {
                    **tool,
                    "stdout": out.read_text(errors="replace"),
                    "stderr": err.read_text(errors="replace"),
                }
                record(
                    "probe_result",
                    tool=tool["name"],
                    return_code=process.returncode,
                    **{k: observation[k] for k in ("stdout", "stderr")},
                )
                if process.returncode != 0:
                    raise RuntimeError("Runtime probe failed: " + tool["name"])
                if not (observation["stdout"].strip() or observation["stderr"].strip()):
                    raise ValueError(
                        "Runtime probe produced no observation: " + tool["name"]
                    )
                observations.append(observation)
            facts = {
                "cwd": cwd,
                "user": user,
                "status": "verified" if declaration else "undeclared",
                "tools": observations,
            }
            (audit_dir / "environment.json").write_text(json.dumps(facts) + "\n")
            record("completed", status=facts["status"])
            return facts
        except BaseException as error:
            record("failed", error_type=type(error).__name__, error=str(error))
            raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--declaration", type=Path, required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--audit-dir", type=Path, required=True)
    args = parser.parse_args()
    value = (
        validate_runtime(json.loads(args.declaration.read_text()))
        if args.declaration.exists()
        else None
    )
    probe(value, cwd=os.getcwd(), user=args.user, audit_dir=args.audit_dir)


def prepare_environment(task, config, *, collector_argv, required, collector_id):
    """Add the shared container contract to a task; Harbor remains the lifecycle owner."""
    import shlex
    import shutil

    task = Path(task)
    environment = task / "environment"
    workspace = config["environment"].get("workdir")
    if not workspace or not Path(workspace).is_absolute():
        raise ValueError("Task must declare an absolute workdir")
    # Each service has its own platform declaration; the verifier does not inherit main's compose file.
    import yaml

    for directory, settings in (
        (environment, config["environment"]),
        (task / "tests", config["verifier"].get("environment") or {}),
    ):
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "docker-compose.yaml"
        compose = yaml.safe_load(path.read_text()) if path.exists() else {}
        service = compose.setdefault("services", {}).setdefault("main", {})
        service.update(platform="linux/amd64", init=True)
        if settings.get("network_mode") == "no-network":
            # Firewall-only egress control still permits local resolver/ICMP paths.
            # Offline task declarations have no network interface except loopback.
            service["network_mode"] = "none"
        path.write_text(yaml.safe_dump(compose, sort_keys=False))
    config["environment"]["build_timeout_sec"] = 1800
    if config["verifier"].get("collect"):
        raise ValueError(
            "Task collection must be composed through the task collector contract"
        )
    reserved = ("/submission", "/benchmark-audit")
    for artifact in config.get("artifacts", []):
        source = artifact if isinstance(artifact, str) else artifact["source"]
        if any(
            source == prefix or source.startswith(prefix + "/") for prefix in reserved
        ):
            raise ValueError("Task artifact conflicts with the handoff-owned paths")
    declaration = read_task_runtime(environment)
    for filename in ("runtime.py", "handoff.py"):
        shutil.copyfile(Path(__file__).with_name(filename), environment / filename)
    settings = {
        "user": "benchmark-runner",
        "workspace": workspace,
        "submission_dir": "/submission",
        "staging_dir": "/benchmark-staging",
        "collector_argv": collector_argv,
        "collector_id": collector_id,
        "required": required,
    }
    (environment / "handoff-config.json").write_text(
        json.dumps(settings, indent=2) + "\n"
    )
    declaration_copy = (
        "COPY runtime.json /opt/benchmark/runtime.json\n" if declaration else ""
    )
    with (environment / "Dockerfile").open("a") as dockerfile:
        dockerfile.write(
            "\n"
            + """USER root
RUN test "$(uname -m)" = x86_64 && . /etc/os-release && case "$ID" in debian|ubuntu) ;; *) exit 1;; esac
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 util-linux procps ca-certificates && rm -rf /var/lib/apt/lists/*
RUN ! getent passwd 10001 && ! getent group 10001 && useradd --uid 10001 --user-group --create-home --shell /bin/bash benchmark-runner
RUN mkdir -p /opt/benchmark /benchmark-audit /benchmark-staging /submission /tests /logs/verifier && chmod 755 /benchmark-staging /submission && chmod 700 /benchmark-audit /logs/verifier && chmod 755 /logs
"""
            + declaration_copy
            + "RUN chown -R 10001:10001 "
            + shlex.quote(workspace)
            + "\n"
        )
    healthcheck = config["environment"].get("healthcheck")
    if healthcheck is not None:
        raise ValueError(
            "Task already has a healthcheck; compose readiness explicitly in the task before preparation"
        )
    config["environment"]["healthcheck"] = {
        "command": "chmod 755 /logs && install -d -m 700 -o 10001 -g 10001 /logs/agent && /usr/bin/python3 /opt/benchmark/runtime.py --declaration /opt/benchmark/runtime.json --user benchmark-runner --audit-dir /benchmark-audit",
        "timeout_sec": 30 * len((declaration or {}).get("tools", [])) + 10,
        "retries": 1,
    }
    config["agent"]["user"] = "benchmark-runner"
    config["verifier"]["collect"] = [
        {
            "command": "/usr/bin/python3 /opt/benchmark/handoff.py collect --config /opt/benchmark/handoff-config.json --audit-dir /benchmark-audit",
            "user": "root",
            "timeout_sec": 120,
        }
    ]
    config.setdefault("artifacts", []).extend(
        [{"source": "/submission"}, {"source": "/benchmark-audit"}]
    )


def freeze_task_images(task, config):
    """Build both task-owned environments once; callers may add their adapter layer first."""
    task = Path(task)
    environments = [
        ("agent", task / "environment", config.environment),
        ("verifier", task / "tests", config.verifier.environment),
    ]
    if any(
        settings is None or settings.docker_image is not None
        for _, _, settings in environments
    ):
        raise ValueError("Freeze requires source definitions for both environments")
    # Runtime support is finalized after adapter dependencies. Updating the benchmark
    # must not invalidate the expensive framework installation layer.
    with (task / "environment/Dockerfile").open("a") as stream:
        stream.write(
            "\nCOPY runtime.py handoff.py handoff-config.json /opt/benchmark/\n"
        )
    images = {}
    for name, directory, settings in environments:
        image_file = task / (name + "-image-id.txt")
        subprocess.run(
            [
                "docker",
                "build",
                "--platform",
                "linux/amd64",
                "--iidfile",
                str(image_file),
                str(directory),
            ],
            check=True,
            stdout=sys.stdout,
            stderr=sys.stderr,
            timeout=1800,
        )
        image = image_file.read_text().strip()
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
            raise ValueError("Docker did not return an immutable image ID")
        settings.docker_image = image
        images[name] = image
    (task / "task.toml").write_text(config.model_dump_toml())
    return images
