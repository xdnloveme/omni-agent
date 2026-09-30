"""Dependency names come from metadata; interpreter selection remains explicit."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from benchmark.taskpacks.swe.verifier.build_dependencies import (
    prepare,
    validate_declarations,
)


class BuildDependencyTest(unittest.TestCase):
    def test_materializes_project_requirements_with_declared_interpreter(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / "project"
            project.mkdir()
            (project / "pyproject.toml").write_text(
                '[build-system]\nrequires = ["example-backend>=2", "example-plugin==1"]\n'
            )
            (root / "build-dependencies.json").write_text(
                json.dumps([{"python": "/task/python", "project": str(project)}])
            )

            def download(argv, **kwargs):
                self.assertEqual(argv[:4], ["/task/python", "-m", "pip", "download"])
                self.assertEqual(argv[-2:], ["example-backend>=2", "example-plugin==1"])
                (root / "build-wheels/example.whl").write_bytes(b"wheel")

            with patch(
                "benchmark.taskpacks.swe.verifier.build_dependencies.subprocess.run",
                side_effect=download,
            ) as run:
                prepare(root)
            run.assert_called_once()
            manifest = json.loads(
                (root / "build-dependencies-manifest.json").read_text()
            )
            self.assertEqual(
                manifest["wheels"]["example.whl"], hashlib.sha256(b"wheel").hexdigest()
            )
            self.assertEqual(
                manifest["projects"][0]["requires"],
                ["example-backend>=2", "example-plugin==1"],
            )

    def test_rejects_ambiguous_declarations_and_option_injection(self):
        for value in (
            {},
            [{"python": "python", "project": "/testbed"}],
            [{"python": "/bin/python"}],
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_declarations(value)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "pyproject.toml").write_text(
                '[build-system]\nrequires = ["--index-url=unexpected"]\n'
            )
            (root / "build-dependencies.json").write_text(
                json.dumps([{"python": "/task/python", "project": str(root)}])
            )
            with patch(
                "benchmark.taskpacks.swe.verifier.build_dependencies.subprocess.run"
            ) as run:
                with self.assertRaises(ValueError):
                    prepare(root)
                run.assert_not_called()
