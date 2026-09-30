"""Materialize pinned isolated SWE tasks using Harbor's native task contract."""

import argparse
import asyncio
import hashlib
import json
import re
import shutil
from pathlib import Path

from benchmark.environments.runtime import prepare_environment, validate_runtime
from benchmark.taskpacks.swe.verifier.build_dependencies import validate_declarations
from harbor.models.task.config import TaskConfig
from harbor.models.task.id import GitTaskId
from harbor.tasks.client import TaskClient

ROOT = Path(__file__).resolve().parents[3]
SOURCE_URL = "https://github.com/laude-institute/harbor-datasets.git"
SOURCE_REVISION = "61366953049fd63a7dff54f67193bf39f5d1cde6"


async def prepare(
    output: Path,
    task_id: GitTaskId,
    image: str,
    runtime: dict | None = None,
    expected_hashes: dict[str, str] | None = None,
    build_dependencies: list[dict[str, str]] | None = None,
) -> None:
    if output.exists():
        raise ValueError("Derived task output must be new; preserve previous evidence")
    downloaded = await TaskClient().download_tasks([task_id])
    source = downloaded.results[0].path
    for name, expected in (expected_hashes or {}).items():
        path = (source / name).resolve()
        if not path.is_relative_to(source.resolve()):
            raise ValueError("Invalid upstream file identity")
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError("Upstream task identity mismatch: " + name)
    config = TaskConfig.model_validate_toml((source / "task.toml").read_text())
    data = config.model_dump(mode="json")
    # Preserve upstream environment provisioning, pinning only its base image.
    environment_dockerfile = (source / "environment/Dockerfile").read_text()
    environment_dockerfile, base_count = re.subn(
        r"^FROM\s+[^\n]+$",
        "FROM " + image,
        environment_dockerfile,
        flags=re.MULTILINE,
    )
    if base_count != 1:
        raise ValueError("SWE task must define exactly one Dockerfile base image")
    # Image builds fetch dependencies before the trial. Harbor restores this
    # runtime baseline after every phase, including before submission collection.
    data["environment"].update(
        docker_image=None,
        network_mode="no-network",
        allowed_hosts=[],
        workdir="/testbed",
    )
    data["agent"].update(network_mode="no-network", allowed_hosts=[])
    data["verifier"].update(
        timeout_sec=1800,
        environment_mode="separate",
        network_mode="public",
        allowed_hosts=[],
        environment={
            "network_mode": "public",
            "cpus": 4,
            "memory_mb": 8192,
            "build_timeout_sec": 1800,
        },
    )
    if runtime is not None and (source / "environment/runtime.json").exists():
        raise ValueError(
            "Upstream runtime declaration already exists; do not overwrite it"
        )
    shutil.copytree(source, output)
    (output / "environment/Dockerfile").write_text(environment_dockerfile)
    if runtime is not None:
        runtime_path = output / "environment/runtime.json"
        runtime_path.write_text(json.dumps(validate_runtime(runtime), indent=2) + "\n")
    tests = output / "tests"
    (tests / "build-dependencies.json").write_text(
        json.dumps(
            validate_declarations(
                [] if build_dependencies is None else build_dependencies
            ),
            indent=2,
        )
        + "\n"
    )
    original = (tests / "test.sh").read_bytes()
    (tests / "upstream-test.sh").write_bytes(original)
    for template in (Path(__file__).with_name("verifier")).iterdir():
        if template.is_file():
            if template.name == "Dockerfile.fragment":
                (tests / "Dockerfile").write_text(
                    environment_dockerfile.rstrip() + "\n" + template.read_text()
                )
            else:
                shutil.copyfile(template, tests / template.name)
    assert (tests / "upstream-test.sh").read_bytes() == original
    assert (output / "instruction.md").read_bytes() == (
        source / "instruction.md"
    ).read_bytes()
    # Task-owned collection is identical for Omni and Oracle.
    shutil.copyfile(
        Path(__file__).with_name("collect-submission.sh"),
        output / "environment/collect-submission.sh",
    )
    with (output / "environment/Dockerfile").open("a") as stream:
        stream.write(
            "\nCOPY collect-submission.sh /opt/swe/collect-submission.sh\nRUN git -C /testbed rev-parse HEAD > /opt/swe/baseline\n"
        )
    prepare_environment(
        output,
        data,
        collector_argv=[
            "bash",
            "/opt/swe/collect-submission.sh",
            "--baseline-file",
            "/opt/swe/baseline",
        ],
        required=["changes.patch"],
        collector_id="swe-git-v1",
    )
    shutil.copyfile(ROOT / "benchmark/environments/handoff.py", tests / "handoff.py")
    (output / "task.toml").write_text(TaskConfig.model_validate(data).model_dump_toml())
    manifest = {
        "protocol": "isolated-swe-v3",
        "status": "requires_runtime_validation",
        "source": task_id.model_dump(mode="json"),
        "source_content_hash": downloaded.results[0].content_hash,
        "task_image": image,
        "upstream_verifier_sha256": hashlib.sha256(original).hexdigest(),
        "derived_files_sha256": {
            str(path.relative_to(output)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(output.rglob("*"))
            if path.is_file()
        },
    }
    (output / "derivation.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--task-name", required=True)
    parser.add_argument(
        "--dataset",
        choices=["swebench_multilingual", "swebench-verified"],
        required=True,
        help="Dataset directory in the pinned Harbor source revision",
    )
    parser.add_argument(
        "--image", required=True, help="Pinned Docker image with sha256 digest"
    )
    parser.add_argument(
        "--runtime-manifest",
        type=Path,
        help="Task environment tool declarations; verified before model execution",
    )
    parser.add_argument(
        "--build-dependencies-manifest",
        type=Path,
        help="Explicit container interpreter/project declarations for offline build requirements",
    )
    args = parser.parse_args()
    image = args.image

    if not re.fullmatch(r"[a-z0-9._/:-]+@sha256:[a-f0-9]{64}", image):
        parser.error("--image must be a pinned sha256 image reference")
    if not re.fullmatch(r"[a-z0-9_-]+", args.task_name):
        parser.error("invalid task name")
    task_id = GitTaskId(
        git_url=SOURCE_URL,
        git_commit_id=SOURCE_REVISION,
        path=Path("datasets") / args.dataset / args.task_name,
    )
    runtime = (
        validate_runtime(json.loads(args.runtime_manifest.read_text()))
        if args.runtime_manifest
        else None
    )
    asyncio.run(
        prepare(
            args.output_dir.resolve(),
            task_id,
            image,
            runtime,
            build_dependencies=json.loads(args.build_dependencies_manifest.read_text())
            if args.build_dependencies_manifest
            else None,
        )
    )
