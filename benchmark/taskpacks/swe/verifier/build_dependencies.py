"""Materialize declared Python build requirements for isolated, offline installs.

The taskpack supplies project and interpreter paths. Package names come only from
project metadata; this provisioner does not infer an interpreter or disable build isolation.
Other ecosystems retain their upstream provisioning and must pass the same official grading controls.
"""

import hashlib
import json
import subprocess
import tomllib
from pathlib import Path


def validate_declarations(value):
    if not isinstance(value, list):
        raise ValueError(
            "Build dependencies must be a list of Python project declarations"
        )
    for item in value:
        if not isinstance(item, dict) or set(item) != {"python", "project"}:
            raise ValueError("Build dependency declarations require python and project")
        if any(
            not isinstance(v, str) or not Path(v).is_absolute() for v in item.values()
        ):
            raise ValueError("Build dependency paths must be absolute container paths")
    return value


def prepare(directory):
    declarations = validate_declarations(
        json.loads((directory / "build-dependencies.json").read_text())
    )
    wheelhouse = directory / "build-wheels"
    wheelhouse.mkdir(exist_ok=True)
    projects = []
    for item in declarations:
        metadata = Path(item["project"]) / "pyproject.toml"
        if not metadata.exists():
            # A legacy project has no PEP 518 requirements to materialize. The
            # official evaluation remains the readiness authority.
            continue
        data = metadata.read_bytes()
        requires = (
            tomllib.loads(data.decode()).get("build-system", {}).get("requires", [])
        )
        if not isinstance(requires, list) or any(
            not isinstance(r, str) or not r or r.startswith("-") for r in requires
        ):
            raise ValueError("Invalid build-system.requires")
        if requires:
            subprocess.run(
                [
                    item["python"],
                    "-m",
                    "pip",
                    "download",
                    "--only-binary=:all:",
                    "--dest",
                    str(wheelhouse),
                    *requires,
                ],
                check=True,
            )
        projects.append(
            {
                **item,
                "metadata_sha256": hashlib.sha256(data).hexdigest(),
                "requires": requires,
            }
        )
    (directory / "build-dependencies-manifest.json").write_text(
        json.dumps(
            {
                "projects": projects,
                "wheels": {
                    p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in sorted(wheelhouse.iterdir())
                    if p.is_file()
                },
            },
            indent=2,
        )
        + "\n"
    )
