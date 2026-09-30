"""Resolve a pinned SWE manifest entry and reuse the SWE task preparer."""

import asyncio
import json
import subprocess
import sys

from harbor.models.task.id import GitTaskId
from benchmark.environments.runtime import validate_runtime
from benchmark.taskpacks.swe.prepare import prepare
from benchmark.taskpacks.swe.verifier.build_dependencies import validate_declarations


class SuiteTaskpack:
    def __init__(self, options, profile_dir, manifest):
        if set(options) not in (
            {"runtime_manifest"},
            {"runtime_manifest", "build_dependencies_manifest"},
        ):
            raise ValueError("SWE preparation requires runtime_manifest")
        self.runtime = validate_runtime(
            json.loads((profile_dir / options["runtime_manifest"]).read_text())
        )
        self.build_dependencies = (
            validate_declarations(
                json.loads(
                    (profile_dir / options["build_dependencies_manifest"]).read_text()
                )
            )
            if "build_dependencies_manifest" in options
            else []
        )
        self.source = manifest["sources"]["harbor"]

    def resolve(self, task, requirements):
        image = task.get("pinned_base_image") or task["upstream_image"]
        # Mutable tags are resolved afresh. Cache identities contain immutable image digests.
        if (
            "@sha256:" not in image
            or subprocess.run(
                ["docker", "image", "inspect", image],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ).returncode
        ):
            subprocess.run(
                ["docker", "pull", "--platform", "linux/amd64", image],
                check=True,
                stdout=sys.stdout,
                stderr=sys.stderr,
            )
        inspected = json.loads(
            subprocess.check_output(["docker", "image", "inspect", image])
        )[0]
        if inspected["Architecture"] != "amd64":
            raise ValueError("SWE task image must be amd64")
        if "@sha256:" not in image:
            repository = image.rsplit(":", 1)[0]
            image = next(
                d for d in inspected["RepoDigests"] if d.startswith(repository + "@")
            )
        return {
            "source": {
                "git_url": self.source["repository"],
                "git_commit_id": self.source["commit"],
                "path": task["harbor_task_path"],
            },
            "image": image,
            "runtime": self.runtime,
            "build_dependencies": self.build_dependencies,
            "expected_hashes": task["harbor_source_sha256"],
        }

    def prepare(self, task, output, resolved):
        asyncio.run(
            prepare(
                output,
                GitTaskId.model_validate(resolved["source"]),
                resolved["image"],
                resolved["runtime"],
                resolved["expected_hashes"],
                resolved["build_dependencies"],
            )
        )
