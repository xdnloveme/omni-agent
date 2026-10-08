"""Preparation lifecycle for trusted taskpack/adapter plugins, before model execution.

Taskpacks own task semantics; adapters own Agent packaging and credentials.
Plugins declare immutable inputs and produce the existing Harbor task contract.
"""

import asyncio
import copy
import logging
import hashlib
import importlib
import inspect
import json
import shutil
import subprocess
import uuid
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

from filelock import FileLock
from harbor.models.task.config import TaskConfig

ROOT = Path(__file__).resolve().parents[1]


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def files_digest(root):
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(Path(root).rglob("*"))
        if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc"
    }


def implementation_identity(plugins):
    result = {
        name: files_digest(ROOT / "benchmark" / name)
        for name in ("adapters", "taskpacks", "environments")
    }
    for name in ("preparation.py", "pyproject.toml", "uv.lock"):
        result[name] = hashlib.sha256(
            (ROOT / "benchmark" / name).read_bytes()
        ).hexdigest()
    result["plugin_entrypoints"] = {
        type(plugin).__module__ + ":" + type(plugin).__qualname__: hashlib.sha256(
            Path(inspect.getfile(type(plugin))).read_bytes()
        ).hexdigest()
        for plugin in plugins
    }
    return result


def load_plugin(declaration, *args):
    if set(declaration) != {"entrypoint", "options"} or not isinstance(
        declaration["options"], dict
    ):
        raise ValueError("Preparation plugins require entrypoint and options")
    module, name = declaration["entrypoint"].split(":")
    return getattr(importlib.import_module(module), name)(declaration["options"], *args)


def check_images(task):
    config = TaskConfig.model_validate_toml((task / "task.toml").read_text())
    for settings in (config.environment, config.verifier.environment):
        if (
            settings is None
            or not settings.docker_image
            or not settings.docker_image.startswith("sha256:")
        ):
            raise ValueError(
                "Preparation must produce immutable agent and verifier images"
            )
        subprocess.run(
            ["docker", "image", "inspect", settings.docker_image],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    return config


def check_environment(task, work, execution):
    """Reuse Harbor startup and healthcheck semantics without starting any Agent."""
    from harbor.environments.factory import EnvironmentFactory
    from harbor.models.trial.config import EnvironmentConfig
    from harbor.models.trial.paths import TrialPaths, EnvironmentPaths
    from harbor.trial.artifact_handler import ArtifactHandler

    config = check_images(task)
    if config.environment.healthcheck is None:
        raise ValueError("Prepared task must declare an environment healthcheck")
    runtime = EnvironmentConfig.model_validate(execution.get("environment", {}))
    paths = TrialPaths(work)
    paths.mkdir()
    name = "benchmark-readiness-" + uuid.uuid4().hex
    logger = logging.getLogger(name)
    logger.setLevel(logging.DEBUG)
    handler = logging.FileHandler(work / "environment.log")
    logger.addHandler(handler)
    logger.propagate = False

    async def validate():
        # Use Harbor's resource enforcement for each phase; never guess capacity
        # or reduce the task's requirements to fit the current machine.
        phases = [("agent", config.environment, task / "environment", runtime)]
        if config.verifier.environment_mode == "separate":
            phases.append(
                (
                    "verifier", config.verifier.environment, task / "tests",
                    runtime.model_copy(update={"extra_docker_compose": []}),
                )
            )
        for phase, settings, context, execution_config in phases:
            phase_paths = paths if phase == "agent" else TrialPaths(work / phase)
            phase_paths.mkdir()
            environment = EnvironmentFactory.create_environment_from_config(
                config=execution_config,
                environment_dir=context,
                environment_name=task.name,
                session_id=name + "-" + phase,
                trial_paths=phase_paths,
                task_env_config=settings,
                logger=logger,
                network_policy=settings.resolve_baseline(),
            )
            started = False
            try:
                await asyncio.wait_for(
                    environment.start(force_build=False),
                    settings.build_timeout_sec,
                )
                started = True
                await environment.run_healthcheck()
            finally:
                try:
                    if started and phase == "agent":
                        await ArtifactHandler(
                            artifacts=config.artifacts, logger=logger
                        ).download_artifacts(
                            environment,
                            paths.artifacts_dir,
                            source_artifacts_dir=EnvironmentPaths.for_os(
                                settings.os
                            ).artifacts_dir,
                        )
                finally:
                    await environment.stop(delete=True)

    try:
        asyncio.run(validate())
    finally:
        logger.removeHandler(handler)
        handler.close()


def prepare_selected(config, selection, job, record, persist):
    """Publish only complete validated cache entries; keep failed work with its job."""
    declaration = selection["preparation"]
    if set(declaration) != {"taskpack", "adapter"}:
        raise ValueError("Preparation requires taskpack and adapter declarations")
    profile_dir = Path(selection["profile_path"]).parent
    manifest_bytes = Path(selection["manifest_path"]).read_bytes()
    if hashlib.sha256(manifest_bytes).hexdigest() != selection["manifest_sha256"]:
        raise ValueError("Manifest changed after selection")
    manifest = json.loads(manifest_bytes)
    taskpack = load_plugin(declaration["taskpack"], profile_dir, manifest)
    result = copy.deepcopy(config)
    adapter = load_plugin(declaration["adapter"], profile_dir, result)
    work = job / "preparation"
    work.mkdir()
    record["preparation"] = {"state": "running", "tasks": []}
    persist()
    # Freeze packaging inputs without requiring model authentication.
    with (
        (work / "preflight.log").open("w") as log,
        redirect_stdout(log),
        redirect_stderr(log),
    ):
        snapshot = adapter.snapshot(work)
        for command in (
            ["docker", "info"],
            ["docker", "compose", "version"],
            ["docker", "buildx", "version"],
        ):
            subprocess.run(command, check=True, stdout=log, stderr=log, timeout=30)
    plugins = (taskpack, adapter)
    implementation = implementation_identity(plugins)
    cache = Path(selection["task_root"])
    selected = {t["id"]: t for t in manifest["tasks"]}
    paths = []
    for task_id in selection["task_ids"]:
        task = selected[task_id]
        status = {"id": task_id, "state": "resolving"}
        record["preparation"]["tasks"].append(status)
        persist()
        task_work = work / task_id
        task_work.mkdir()
        with (
            (task_work / "prepare.log").open("w") as log,
            redirect_stdout(log),
            redirect_stderr(log),
        ):
            # subprocess output uses the same durable log, including failed image builds.
            resolved = taskpack.resolve(task, snapshot["requirements"])
            identity = {
                "plugins": declaration,
                "task": resolved,
                "adapter": snapshot["identity"],
                "implementation": implementation,
            }
            key = digest(identity)
            parent = cache / task_id
            parent.mkdir(parents=True, exist_ok=True)
            entry = parent / key
            status.update(state="waiting", key=key, path=str(entry / task_id))
            persist()
            with FileLock(str(parent / (key + ".lock")), timeout=1800):
                receipt = entry / "receipt.json"
                hit = False
                if receipt.exists():
                    stored = json.loads(receipt.read_text())
                    if stored["identity"] != identity or stored[
                        "files"
                    ] != files_digest(entry / task_id):
                        raise ValueError(
                            "Prepared cache integrity check failed: " + task_id
                        )
                    try:
                        check_images(entry / task_id)
                        hit = True
                    except subprocess.CalledProcessError:
                        # Missing local Docker images invalidate the cache; never use a partial entry.
                        shutil.move(str(entry), str(task_work / "expired-cache"))
                elif entry.exists():
                    raise ValueError("Incomplete cache entry: " + str(entry))
                if not hit:
                    status["state"] = "building"
                    persist()
                    source = task_work / "source"
                    taskpack.prepare(task, source, resolved)
                    staging = parent / (".building-" + uuid.uuid4().hex)
                    staging.mkdir()
                    try:
                        adapter.prepare(source, staging / task_id, snapshot)
                        check_environment(
                            staging / task_id, task_work / "readiness", result
                        )
                        if implementation_identity(plugins) != implementation:
                            raise ValueError(
                                "Preparation implementation changed during build; rerun from a stable checkout"
                            )
                        (staging / "receipt.json").write_text(
                            json.dumps(
                                {
                                    "identity": identity,
                                    "files": files_digest(staging / task_id),
                                },
                                indent=2,
                            )
                        )
                        staging.rename(entry)
                    except BaseException:
                        shutil.move(str(staging), str(task_work / "failed-build"))
                        raise
                else:
                    check_environment(entry / task_id, task_work / "readiness", result)
                status.update(state="ready", cache_hit=hit)
                persist()
                paths.append({"path": str(entry / task_id)})
    result["tasks"] = paths
    record["preparation"]["state"] = "ready"
    persist()
    return result
