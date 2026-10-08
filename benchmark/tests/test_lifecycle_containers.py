"""Opt-in lifecycle acceptance using real Harbor/Omni and a local model fixture.

Set BENCHMARK_LIFECYCLE_TASK to a prepared execution-contract/files task and
BENCHMARK_LIFECYCLE_ROOT to a new Docker-shared evidence directory. No real
Provider credentials are read. The fixture performs deterministic tool calls;
these tests validate infrastructure, not model reasoning or paid throughput.
"""

import json
import os
from pathlib import Path
from harbor.models.task.config import TaskConfig, NetworkMode
import shutil
import signal
import shlex
import subprocess
import sys
import time
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(
    os.environ.get("BENCHMARK_LIFECYCLE_TASK"),
    "Set BENCHMARK_LIFECYCLE_TASK and BENCHMARK_LIFECYCLE_ROOT for container acceptance",
)
class ContainerLifecycleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(os.environ["BENCHMARK_LIFECYCLE_ROOT"]).resolve()
        cls.root.mkdir(parents=True, exist_ok=False)
        cls.tasks = []
        for index in range(5):
            target = cls.root / "tasks" / f"isolation-{index}"
            shutil.copytree(os.environ["BENCHMARK_LIFECYCLE_TASK"], target)
            cls.tasks.append(target)

    def run_case(
        self, name, *, count=1, fault=None, delay=0, budget=120, interrupt=None
    ):
        case = self.root / name
        case.mkdir()
        config = yaml.safe_load(
            (ROOT / "benchmark/configs/harbor/smoke.yaml").read_text()
        )
        config["agents"] = config["agents"][:1]
        config["tasks"] = [{"path": str(p)} for p in self.tasks[:count]]
        config["n_concurrent_trials"] = count
        config["benchmark"]["agent_timeout_sec"] = budget
        for task in self.tasks[:count]:
            compose_path = task / "environment/docker-compose.yaml"
            compose = yaml.safe_load(compose_path.read_text())
            compose["services"]["omni-model"]["environment"].update(
                {
                    "OMNI_SMOKE_DELAY_SECONDS": str(delay),
                    "OMNI_SMOKE_FAULT": fault or "",
                }
            )
            compose_path.write_text(yaml.safe_dump(compose))
        path = case / "config.yaml"
        path.write_text(yaml.safe_dump(config))
        # Preserve Docker's host connection settings. Container environment
        # projection belongs to Harbor and the adapter, not this test launcher.
        env = {**os.environ, "OMNI_SMOKE_API_KEY": "fixture"}
        with (case / "command.log").open("w") as log:
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "benchmark.run",
                    "run",
                    "--config",
                    str(path),
                    "--jobs-dir",
                    str(case / "jobs"),
                    "--kind",
                    "fixture",
                ],
                cwd=ROOT,
                env=env,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
            try:
                if interrupt:
                    deadline = time.monotonic() + 180
                    while time.monotonic() < deadline and process.poll() is None:
                        configs = list((case / "jobs").glob("*/*/config.json"))
                        if configs:
                            trial = configs[0].parent.name
                            containers = subprocess.check_output(
                                [
                                    "docker",
                                    "ps",
                                    "--filter",
                                    "name=" + trial.lower(),
                                    "--format",
                                    "{{.ID}} {{.Names}}",
                                ],
                                text=True,
                            ).splitlines()
                            main = next(
                                (
                                    line.split()[0]
                                    for line in containers
                                    if "env-main" in line
                                ),
                                None,
                            )
                            if main:
                                ready = subprocess.run(
                                    [
                                        "docker",
                                        "exec",
                                        main,
                                        "test",
                                        "-s",
                                        "/home/benchmark-runner/output/events.jsonl",
                                    ],
                                    capture_output=True,
                                )
                                if ready.returncode == 0:
                                    if interrupt == "signal":
                                        process.send_signal(signal.SIGINT)
                                    else:
                                        subprocess.run(
                                            ["docker", "stop", "--time", "1", main],
                                            check=True,
                                            capture_output=True,
                                        )
                                    break
                        time.sleep(1)
                    else:
                        self.fail("Agent did not start before fault injection deadline")
                code = process.wait(timeout=360)
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGINT)
                    process.wait(timeout=180)
        job = next((case / "jobs").iterdir())
        invocation = json.loads((job / "invocation.json").read_text())
        trials = [json.loads(p.read_text()) for p in job.glob("*/result.json")]
        self.assertEqual(len(trials), count)
        for trial in trials:
            remaining = subprocess.check_output(
                [
                    "docker",
                    "ps",
                    "-a",
                    "--filter",
                    "name=" + trial["trial_name"].lower(),
                    "--format",
                    "{{.ID}}",
                ],
                text=True,
            ).strip()
            self.assertEqual(remaining, "", "Trial containers must be removed")
        (case / "receipt.json").write_text(
            json.dumps(
                {"exit_code": code, "job": str(job), "cleanup": "verified"}, indent=2
            )
        )
        return invocation, trials, job

    def assert_completed_trial(self, trial, job):
        self.assertIsNone(trial["exception_info"])
        self.assertEqual(trial["verifier_result"]["rewards"]["reward"], 1)
        agent = job / trial["trial_name"] / "agent"
        network = json.loads((agent / "omni/network-probe.json").read_text())
        self.assertEqual(network["interfaces"], ["lo"])
        self.assertTrue(network["credential_absent"])
        self.assertTrue(network["no_inherited_socket"])
        for target in ("ipv4", "ipv6", "provider", "model_channel"):
            self.assertTrue(network[target]["blocked"])
        trace = json.loads((agent / "trace-summary.json").read_text())["traces"]
        self.assertEqual(len(trace), 1)
        self.assertEqual(trace[0]["state"], "complete")
        receipt = json.loads((agent / "model-process.json").read_text())
        self.assertTrue(receipt["stopped"])
        self.assertEqual(receipt["return_code"], 0)
        return trace[0]["session_id"]

    def test_single_trial_completes_with_isolated_credentials_and_cleanup(self):
        _, trials, job = self.run_case("single")
        self.assert_completed_trial(trials[0], job)

    def test_five_concurrent_trials_have_independent_sessions_and_valid_scores(self):
        _, trials, job = self.run_case("concurrent", count=5, delay=2)
        sessions = [self.assert_completed_trial(trial, job) for trial in trials]
        self.assertEqual(len(set(sessions)), 5)
        # Prove execution actually overlapped, rather than accepting a configured number.
        self.assertLess(
            max(t["agent_execution"]["started_at"] for t in trials),
            min(t["agent_execution"]["finished_at"] for t in trials),
        )

    def test_public_verifier_starts_after_sealed_solver_stops(self):
        task = self.root / "public-verifier-task"
        shutil.copytree(self.tasks[0], task)
        config = TaskConfig.model_validate_toml((task / "task.toml").read_text())
        config.verifier.network_mode = NetworkMode.PUBLIC
        config.verifier.environment.network_mode = NetworkMode.PUBLIC
        seal_script = (
            ROOT / "benchmark/tests/fixtures/verify_public_submission.py"
        ).read_text()
        # Exercise permissions in the owner of the seal, before Harbor stops main.
        config.verifier.collect[0].command += (
            " && PYTHONPATH=/opt/benchmark /usr/bin/python3 -c "
            + shlex.quote(seal_script)
            + " --seal"
        )
        compose_path = task / "tests/docker-compose.yaml"
        compose = yaml.safe_load(compose_path.read_text())
        compose["services"]["main"].pop("network_mode")
        compose_path.write_text(yaml.safe_dump(compose))
        shutil.copyfile(
            ROOT / "benchmark/tests/fixtures/verify_public_submission.py",
            task / "tests/verify_public_submission.py",
        )
        script = task / "tests/test.sh"
        script.write_text(
            script.read_text().replace(
                "test \"$(ls /sys/class/net)\" = lo\nprintf 'network_mode=none interfaces=lo\\n' > /logs/verifier/network.txt",
                "python3 /tests/verify_public_submission.py",
            )
        )
        self.assertIn("python3 /tests/verify_public_submission.py", script.read_text())
        image_file = task / "verifier-image-id"
        with (task / "build.log").open("w") as log:
            subprocess.run(
                [
                    "docker",
                    "build",
                    "--platform",
                    "linux/amd64",
                    "--iidfile",
                    str(image_file),
                    str(task / "tests"),
                ],
                check=True,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        image = image_file.read_text().strip()
        config.verifier.environment.docker_image = image
        (task / "task.toml").write_text(config.model_dump_toml())
        original_task = self.tasks[0]
        self.tasks[0] = task
        event_file = self.root / "public-verifier-docker-events.jsonl"
        # Docker retains recent events; --since avoids a subscription-start race.
        since = str(int(time.time()) - 1)
        try:
            with event_file.open("w") as log:
                events = subprocess.Popen(
                    [
                        "docker",
                        "events",
                        "--since",
                        since,
                        "--filter",
                        "type=container",
                        "--format",
                        "{{json .}}",
                    ],
                    stdout=log,
                    stderr=subprocess.PIPE,
                )
                try:
                    _, trials, job = self.run_case("public-verifier")
                finally:
                    events.terminate()
                    events.communicate(timeout=15)
            trial = trials[0]
            self.assertIsNone(trial["exception_info"])
            self.assertEqual(trial["verifier_result"]["rewards"]["reward"], 1)
            trial_dir = job / trial["trial_name"]
            proof = json.loads(
                (trial_dir / "verifier/public-submission.json").read_text()
            )
            self.assertEqual(proof["http_status"], 200)
            self.assertEqual(proof["before"], proof["after"])
            seal = json.loads(
                (trial_dir / "artifacts/benchmark-audit/seal-probe.json").read_text()
            )
            self.assertTrue(seal["solver_write_denied"])
            self.assertEqual(seal["hashes"], proof["before"])
            receipt = json.loads(
                (trial_dir / "artifacts/submission/handoff.json").read_text()
            )
            self.assertEqual(seal["collection_id"], receipt["collection_id"])
            solver_probe = json.loads(
                (trial_dir / "agent/omni/network-probe.json").read_text()
            )
            self.assertEqual(solver_probe["interfaces"], ["lo"])
            self.assertTrue(solver_probe["ipv4"]["blocked"])
            self.assertTrue(solver_probe["credential_absent"])
            entries = [json.loads(line) for line in event_file.read_text().splitlines()]
            relevant = [
                e
                for e in entries
                if trial["trial_name"].lower()
                in e["Actor"]["Attributes"].get("name", "")
            ]
            verifier = next(
                e
                for e in relevant
                if e["Action"] == "start"
                and e["Actor"]["ID"].startswith(proof["container"])
            )
            solver_stops = [
                e
                for e in relevant
                if e["Action"] == "die"
                and "env-main" in e["Actor"]["Attributes"].get("name", "")
            ]
            self.assertEqual(len(solver_stops), 1)
            self.assertLess(solver_stops[0]["timeNano"], verifier["timeNano"])
            (self.root / "public-verifier-order.json").write_text(
                json.dumps(
                    {
                        "solver_die": solver_stops[0],
                        "verifier_start": verifier,
                        "submission": proof,
                        "solver_seal": seal,
                        "trial": trial["trial_name"],
                    },
                    indent=2,
                )
            )
        finally:
            self.tasks[0] = original_task
            subprocess.run(
                ["docker", "image", "rm", "--no-prune", image],
                check=True,
                capture_output=True,
            )

    def test_provider_faults_cannot_be_reported_as_success(self):
        for fault in ("http_error", "disconnect"):
            with self.subTest(fault=fault):
                _, trials, job = self.run_case(fault, fault=fault)
                self.assertIsNotNone(trials[0]["exception_info"])
                self.assertIsNone(trials[0]["verifier_result"])
                agent = job / trials[0]["trial_name"] / "agent"
                trace = json.loads((agent / "trace-summary.json").read_text())["traces"]
                self.assertEqual(trace[0]["state"], "complete")

    def test_deadline_preserves_cancellation_evidence(self):
        _, trials, job = self.run_case("deadline", delay=60, budget=5)
        self.assertIsNotNone(trials[0]["exception_info"])
        self.assertIsNone(trials[0]["verifier_result"])
        trace = json.loads(
            (job / trials[0]["trial_name"] / "agent/trace-summary.json").read_text()
        )["traces"]
        self.assertEqual(trace[0]["status"], "cancelled")
        self.assertEqual(trace[0]["state"], "complete")

    def test_external_cancel_waits_for_cleanup(self):
        invocation, trials, _ = self.run_case("cancel", delay=60, interrupt="signal")
        self.assertEqual(invocation["state"], "cancelled")
        self.assertEqual(invocation["cleanup_status"], "harbor_exited")
        self.assertIsNotNone(trials[0]["exception_info"])

    def test_container_loss_is_an_explicit_failure(self):
        _, trials, _ = self.run_case("container-loss", delay=60, interrupt="container")
        self.assertIsNotNone(trials[0]["exception_info"])
        self.assertIsNone(trials[0]["verifier_result"])
