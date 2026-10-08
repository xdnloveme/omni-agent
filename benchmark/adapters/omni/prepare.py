"""Build immutable Omni + task images before Harbor starts a trial."""

import argparse
import hashlib
import json
import shutil
import subprocess
import tarfile

import yaml
from pathlib import Path

from harbor.models.task.config import TaskConfig, NetworkMode

from benchmark.environments.runtime import freeze_task_images

ROOT = Path(__file__).resolve().parents[3]


def create_source_archive(source, archive):
    source = Path(source).resolve()
    names = (
        subprocess.check_output(
            [
                "git",
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
                "--",
                "apps/omni",
                "packages",
                "agents",
                "package.json",
                "pnpm-lock.yaml",
                "pnpm-workspace.yaml",
                "tsconfig.base.json",
            ],
            cwd=source,
        )
        .decode()
        .split("\0")
    )
    archive = Path(archive)
    with tarfile.open(archive, "w") as bundle:
        for name in sorted(set(filter(None, names))):
            path = Path(name)
            if any(
                part in {"node_modules", "dist"} or part.startswith(".env")
                for part in path.parts
            ):
                continue
            if (source / path).is_file():
                info = bundle.gettarinfo(str(source / path), arcname=name)
                info.mtime = 0
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                with (source / path).open("rb") as stream:
                    bundle.addfile(info, stream)
    return hashlib.sha256(archive.read_bytes()).hexdigest()


def archive_member_hash(archive, name):
    with tarfile.open(archive) as bundle:
        stream = bundle.extractfile(name)
        if stream is None:
            raise ValueError("Missing Agent archive member: " + name)
        return hashlib.sha256(stream.read()).hexdigest()


def prepare(task, output, source, *, source_archive=None):
    task, output, source = map(lambda p: Path(p).resolve(), (task, output, source))
    if output.exists():
        raise ValueError("Prepared task output must be new")
    shutil.copytree(task, output)
    environment = output / "environment"
    config = TaskConfig.model_validate_toml((output / "task.toml").read_text())
    if (
        config.agent.user != "benchmark-runner"
        or not (environment / "handoff-config.json").is_file()
    ):
        raise ValueError(
            "Task must provide the benchmark execution contract before Omni preparation"
        )
    if any(
        mode != NetworkMode.NO_NETWORK
        for mode in (
            config.environment.network_mode,
            config.agent.network_mode,
        )
    ):
        raise ValueError("Isolated Omni execution requires offline solver declarations")
    if config.environment.docker_image is not None:
        raise ValueError("Expected source Dockerfile before composition")
    archive = environment / "omni-source.tar"
    if source_archive is None:
        create_source_archive(source, archive)
    else:
        shutil.copyfile(source_archive, archive)
    shutil.copyfile(
        Path(__file__).with_name("install.sh"), environment / "omni-install.sh"
    )
    with (environment / "Dockerfile").open("a") as stream:
        stream.write(
            "\nCOPY omni-source.tar /installed-agent/omni-source.tar\nCOPY omni-install.sh /installed-agent/install.sh\nRUN bash /installed-agent/install.sh\n"
        )
    source_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
    images = freeze_task_images(output, config)
    compose_path = environment / "docker-compose.yaml"
    compose = yaml.safe_load(compose_path.read_text())
    main = compose["services"]["main"]
    if main.get("network_mode") != "none":
        raise ValueError("Offline task must compile to network_mode none")
    main.setdefault("volumes", []).append("omni-model-channel:/run/omni-model:ro")
    model = compose["services"].setdefault("omni-model", {})
    if set(model) - {"environment"}:
        raise ValueError(
            "Task may only supply environment values for the model service"
        )
    model.update(
        image=images["agent"],
        platform="linux/amd64",
        init=True,
        network_mode="bridge",
        command=["sleep", "infinity"],
        volumes=["omni-model-channel:/run/omni-model"],
        security_opt=["no-new-privileges:true"],
    )
    compose.setdefault("volumes", {})["omni-model-channel"] = {}
    compose_path.write_text(yaml.safe_dump(compose, sort_keys=False))
    manifest = {
        "version": 1,
        "images": images,
        "source_sha256": source_hash,
        "commit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=source, text=True
        ).strip(),
        "pnpm_lock_sha256": archive_member_hash(archive, "pnpm-lock.yaml"),
        "task_config_sha256": hashlib.sha256(
            (output / "task.toml").read_bytes()
        ).hexdigest(),
    }
    (output / "preparation.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source", type=Path, default=ROOT)
    args = parser.parse_args()
    print(json.dumps(prepare(args.task, args.output, args.source), indent=2))
