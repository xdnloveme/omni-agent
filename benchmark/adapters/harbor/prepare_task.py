"""Materialize pinned isolated SWE tasks using Harbor's native task contract."""

import argparse
import asyncio
import hashlib
import json
import re
import shutil
import shlex
from pathlib import Path

from harbor.models.task.config import TaskConfig
from harbor.models.task.id import GitTaskId
from harbor.tasks.client import TaskClient

ROOT = Path(__file__).resolve().parents[3]
TASK_ID = GitTaskId(
    git_url="https://github.com/laude-institute/harbor-datasets.git",
    git_commit_id="61366953049fd63a7dff54f67193bf39f5d1cde6",
    path=Path("datasets/swebench_multilingual/axios__axios-4731"),
)
IMAGE = "swebench/sweb.eval.x86_64.axios_1776_axios-4731@sha256:e75f3f2f1e91fbd09a00bd14a4c807dab210d58a5d7395b595cf65314d092bb1"


async def prepare(
    output: Path, task_id: GitTaskId = TASK_ID, image: str = IMAGE
) -> None:
    if output.exists():
        raise ValueError("Derived task output must be new; preserve previous evidence")
    downloaded = await TaskClient().download_tasks([task_id])
    source = downloaded.results[0].path
    config = TaskConfig.model_validate_toml((source / "task.toml").read_text())
    data = config.model_dump(mode="json")
    data["environment"].update(docker_image=image, network_mode="public")
    data["agent"].update(
        network_mode="allowlist", allowed_hosts=["ark.cn-beijing.volces.com"]
    )
    data["verifier"].update(
        environment_mode="separate",
        network_mode="no-network",
        environment={
            "network_mode": "no-network",
            "cpus": 4,
            "memory_mb": 8192,
            "build_timeout_sec": 1800,
        },
    )
    data["artifacts"] = [{"source": "/submission/changes.patch"}]
    derived = TaskConfig.model_validate(data)
    shutil.copytree(source, output)
    (output / "task.toml").write_text(derived.model_dump_toml())
    tests = output / "tests"
    original = (tests / "test.sh").read_bytes()
    (tests / "upstream-test.sh").write_bytes(original)
    for template in (ROOT / "benchmark/environments/swe-verifier").iterdir():
        if template.is_file():
            if template.name == "Dockerfile":
                body = template.read_text().splitlines(keepends=True)[1:]
                (tests / template.name).write_text(f"FROM {image}\n" + "".join(body))
            else:
                shutil.copyfile(template, tests / template.name)
    assert (tests / "upstream-test.sh").read_bytes() == original
    assert (output / "instruction.md").read_bytes() == (
        source / "instruction.md"
    ).read_bytes()
    # Preserve Harbor's Oracle validation using the same submission collector.
    solution = output / "solution"
    (solution / "solve.sh").rename(solution / "upstream-solve.sh")
    shutil.copyfile(
        Path(__file__).with_name("collect-submission.sh"),
        solution / "collect-submission.sh",
    )
    baseline = json.loads((source / "tests/config.json").read_text())["base_commit"]
    collection = shlex.join(
        [
            "bash",
            "/solution/collect-submission.sh",
            "/testbed",
            baseline,
            "/submission/changes.patch",
        ]
    )
    (solution / "solve.sh").write_text(
        "#!/bin/bash\nset -euo pipefail\nbash /solution/upstream-solve.sh\nmkdir -p /submission\n"
        + collection
        + "\n"
    )
    manifest = {
        "protocol": "isolated-swe-v1",
        "status": "requires_runtime_validation",
        "source": task_id.model_dump(mode="json"),
        "source_content_hash": downloaded.results[0].content_hash,
        "task_image": image,
        "rule_sha256": hashlib.sha256(
            (ROOT / "benchmark/prompts/evaluation-rules.md").read_bytes()
        ).hexdigest(),
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
    parser.add_argument("--task-name", default=TASK_ID.path.name)
    parser.add_argument(
        "--image", help="Pinned Docker image with sha256 digest; required for new tasks"
    )
    args = parser.parse_args()
    if not args.image and args.task_name != TASK_ID.path.name:
        parser.error("--image is required for a different task")
    image = args.image or IMAGE

    if not re.fullmatch(r"[a-z0-9._/:-]+@sha256:[a-f0-9]{64}", image):
        parser.error("--image must be a pinned sha256 image reference")
    if not re.fullmatch(r"[a-z0-9_-]+", args.task_name):
        parser.error("invalid task name")
    task_id = TASK_ID.model_copy(update={"path": TASK_ID.path.parent / args.task_name})
    asyncio.run(prepare(args.output_dir.resolve(), task_id, image))
