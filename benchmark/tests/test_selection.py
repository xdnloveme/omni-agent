"""Selection must be reproducible, complete, and feed the existing tracked runner."""

import argparse
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from benchmark.selection import add_selection_arguments, compile_selection, select_ids
from benchmark.run import main


class SelectionTest(unittest.TestCase):
    def test_selection_is_deterministic_and_keeps_manifest_order(self):
        ids = [f"task-{n}" for n in range(50)]
        self.assertEqual(select_ids(ids, all_tasks=True), ids)
        self.assertEqual(select_ids(ids, first=3), ids[:3])
        self.assertEqual(select_ids(ids, tasks=[ids[8], ids[2]]), [ids[2], ids[8]])
        sample = select_ids(ids, sample=10, seed=42)
        self.assertEqual(sample, select_ids(ids, sample=10, seed=42))
        self.assertEqual(len(sample), 10)
        self.assertEqual(sample, [task for task in ids if task in sample])
        for options in (
            {},
            {"first": 0},
            {"sample": 51, "seed": 1},
            {"sample": 3},
            {"first": 3, "seed": 1},
            {"tasks": ["missing"]},
            {"tasks": [ids[0], ids[0]]},
        ):
            with self.subTest(options=options), self.assertRaises(ValueError):
                select_ids(ids, **options)

    def test_missing_tasks_never_silently_reduce_a_run(self):
        parser = argparse.ArgumentParser()
        add_selection_arguments(parser)
        args = parser.parse_args(["--first", "3"])
        with tempfile.TemporaryDirectory() as directory:
            args.task_root = Path(directory)
            args.action = "list"
            _, record = compile_selection(args)
            self.assertEqual(record["readiness"], "not_checked")
            self.assertNotIn("missing_tasks", record)
            args.action = "run"
            config, record = compile_selection(args)
            self.assertEqual(len(config["tasks"]), 3)
            self.assertIn("preparation", record)
            self.assertEqual(record["readiness"], "not_checked")
            self.assertNotIn("missing_tasks", record)

    def test_cli_passes_selected_config_and_evidence_to_single_run_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "manifest.json").write_text(
                json.dumps({"suite_id": "fixture", "tasks": [{"id": "a"}, {"id": "b"}]})
            )
            (root / "profile.json").write_text(
                json.dumps(
                    {
                        "version": 1,
                        "manifest": "manifest.json",
                        "task_root": "tasks",
                        "execution": {"n_attempts": 1},
                    }
                )
            )
            for task in ("a", "b"):
                (root / "tasks" / task).mkdir(parents=True)
                (root / "tasks" / task / "task.toml").touch()

            def execute(config, jobs, kind, selection):
                import yaml

                value = yaml.safe_load(config.read_text())
                self.assertEqual(value["n_concurrent_trials"], 5)
                self.assertEqual(value["benchmark"]["agent_timeout_sec"], 1200)
                self.assertEqual(
                    [Path(t["path"]).name for t in value["tasks"]], ["a", "b"]
                )
                self.assertEqual(selection["task_ids"], ["a", "b"])
                self.assertEqual(len(selection["manifest_sha256"]), 64)
                self.assertEqual(kind, "fixture")
                return 7

            with (
                patch(
                    "sys.argv",
                    [
                        "benchmark",
                        "run",
                        "--profile",
                        str(root / "profile.json"),
                        "--all",
                        "--concurrency",
                        "5",
                        "--timeout",
                        "1200",
                        "--kind",
                        "fixture",
                    ],
                ),
                patch("benchmark.run.tracked_run", side_effect=execute) as run,
            ):
                self.assertEqual(main(), 7)
                run.assert_called_once()
