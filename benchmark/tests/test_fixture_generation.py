"""Generated task entrypoints must execute, not merely serialize valid task.toml."""

import ast
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class FixtureGenerationTest(unittest.TestCase):
    def test_generated_scripts_have_valid_syntax_for_both_submission_formats(self):
        prepare = runpy.run_path(
            str(ROOT / "benchmark/tasks/execution-contract/prepare.py")
        )["prepare"]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "tasks"
            prepare(output)
            for path in output.rglob("*.sh"):
                subprocess.run(
                    ["bash", "-n", str(path)], check=True, capture_output=True
                )
            for path in output.rglob("*.py"):
                ast.parse(path.read_text())
