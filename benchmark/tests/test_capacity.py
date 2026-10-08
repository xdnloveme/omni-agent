"""Capacity observations never become guessed admission or cleanup policy."""

import json
import tempfile
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from benchmark.capacity import capture_capacity, docker_capacity


class CapacityTest(unittest.TestCase):
    def test_cold_cache_is_unknown_and_never_pulls_a_probe_image(self):
        with (
            patch(
                "benchmark.capacity.subprocess.check_output",
                return_value=b'{"Driver":"overlay2"}',
            ),
            patch("benchmark.capacity.local_task_image", return_value=None),
            patch("benchmark.capacity.subprocess.run") as run,
        ):
            result = docker_capacity({}, None)
        self.assertEqual(result["state"], "unknown")
        self.assertEqual(result["reason"], "no_local_selected_task_image")
        run.assert_not_called()

    def test_measures_container_filesystem_without_network_or_pull_and_cleans_up(self):
        commands = []

        def execute(argv, **kwargs):
            commands.append(argv)
            return SimpleNamespace(
                returncode=0,
                stdout="Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 1000 900 50 95% /\n"
                if argv[1] == "run"
                else "",
            )

        with (
            patch(
                "benchmark.capacity.subprocess.check_output",
                return_value=b'{"Driver":"overlay2"}',
            ),
            patch("benchmark.capacity.local_task_image", return_value="sha256:fixture"),
            patch("benchmark.capacity.subprocess.run", side_effect=execute),
        ):
            result = docker_capacity({}, None)
        self.assertEqual(result["available_bytes"], 50 * 1024)
        self.assertEqual(result["cleanup"], "verified")
        run = commands[0]
        self.assertEqual(run[run.index("--pull") + 1], "never")
        self.assertEqual(run[run.index("--network") + 1], "none")
        self.assertIn("--read-only", run)
        self.assertEqual(commands[-1][1], "ps")

    def test_timed_out_probe_is_unknown_and_still_cleaned_up(self):
        commands = []

        def execute(argv, **kwargs):
            commands.append(argv)
            if argv[1] == "run":
                raise subprocess.TimeoutExpired(argv, 20)
            return SimpleNamespace(returncode=0, stdout="")

        with (
            patch("benchmark.capacity.subprocess.check_output", return_value=b"{}"),
            patch("benchmark.capacity.local_task_image", return_value="sha256:fixture"),
            patch("benchmark.capacity.subprocess.run", side_effect=execute),
        ):
            result = docker_capacity({}, None)
        self.assertEqual(result["state"], "unknown")
        self.assertEqual(result["reason"], "TimeoutExpired")
        self.assertEqual(result["cleanup"], "verified")
        self.assertEqual(commands[1][:3], ["docker", "rm", "--force"])

    def test_missing_docker_is_unknown_and_host_space_is_not_a_substitute(self):
        with (
            tempfile.TemporaryDirectory() as job,
            patch(
                "benchmark.capacity.subprocess.check_output",
                side_effect=FileNotFoundError(),
            ),
        ):
            result = capture_capacity(
                job,
                {"n_concurrent_trials": 5, "tasks": [{"path": "a"}]},
                None,
                "before_execution",
            )
        self.assertEqual(result["host"]["jobs"]["state"], "available")
        self.assertEqual(result["docker"]["state"], "unknown")
        self.assertIsNone(result["required_bytes"])
        self.assertIsNone(result["capacity_sufficient"])
        self.assertEqual(result["trial_concurrency"], 5)
        json.dumps(result)
