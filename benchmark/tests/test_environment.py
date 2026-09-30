import json
import os
import pwd
import sys
import tempfile
import unittest
from pathlib import Path

from benchmark.environments.runtime import probe, validate_runtime


class EnvironmentContractTest(unittest.TestCase):
    def test_wrapper_and_failure_preserve_execution_facts_and_partial_audit(self):
        with tempfile.TemporaryDirectory(prefix="runtime space ") as directory:
            root = Path(directory)
            (root / "wrapper.py").write_text("import os; print(os.getcwd())")
            declaration = validate_runtime(
                {
                    "version": 2,
                    "tools": [
                        {
                            "name": "wrapper",
                            "argv_prefix": [sys.executable, "wrapper.py"],
                            "probe_args": ["--version"],
                            "description": "Project wrapper",
                        },
                        {
                            "name": "failure",
                            "argv_prefix": [sys.executable],
                            "probe_args": [
                                "-c",
                                'print("diagnostic"); raise SystemExit(7)',
                            ],
                            "description": "Failure fixture",
                        },
                    ],
                }
            )
            audit = root / "audit"
            with self.assertRaises(RuntimeError):
                probe(
                    declaration,
                    cwd=directory,
                    user=pwd.getpwuid(os.getuid()).pw_name,
                    audit_dir=audit,
                )
            events = [
                json.loads(line)
                for line in (audit / "runtime-probes.jsonl").read_text().splitlines()
            ]
            self.assertEqual(events[-1]["event"], "failed")
            self.assertIn(directory, events[2]["stdout"])
            self.assertIn("diagnostic", (audit / "failure.stdout").read_text())
            self.assertFalse((audit / "environment.json").exists())

    def test_undeclared_does_not_claim_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            facts = probe(
                None,
                cwd=directory,
                user=pwd.getpwuid(os.getuid()).pw_name,
                audit_dir=Path(directory) / "audit",
            )
            self.assertEqual(facts["status"], "undeclared")
            self.assertEqual(facts["tools"], [])

    def test_invalid_version_and_ambiguous_names_rejected(self):
        tool = {
            "name": "x",
            "argv_prefix": ["x"],
            "probe_args": ["--version"],
            "description": "",
        }
        for value in [
            {"version": 1, "tools": []},
            {"version": 2, "tools": [tool, tool]},
            {"version": 2, "tools": [{**tool, "argv_prefix": []}]},
        ]:
            with self.assertRaises(ValueError):
                validate_runtime(value)
