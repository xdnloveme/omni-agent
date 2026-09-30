import json
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import MagicMock, patch

from benchmark.adapters.omni.evidence import inspect_traces
from benchmark.run import check_config, index_job, tracked_run


class RunEvidenceTest(unittest.TestCase):
    def setUp(self):
        capacity = patch(
            "benchmark.capacity.capture_capacity",
            side_effect=lambda job, config, selection, phase: {"phase": phase},
        )
        capacity.start()
        self.addCleanup(capacity.stop)

    def test_index_preserves_task_owned_verifier_evidence_and_official_score(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            trial = job / "trial"
            verifier = trial / "verifier"
            verifier.mkdir(parents=True)
            native = {
                "verifier_result": {"rewards": {"reward": 0}},
                "exception_info": None,
            }
            (trial / "result.json").write_text(json.dumps(native))
            contents = {
                "report.json": '{"resolved":false}',
                "error.json": '{"stage":"evaluation","message":"opaque producer fact"}',
                "test-output.txt": "task-owned raw output",
                "command-errors.log": "1\tpytest",
                "another-format.bin": "opaque evidence",
            }
            for name, content in contents.items():
                (verifier / name).write_text(content)
            (verifier / "escape").symlink_to(job / "outside")
            (job / "outside").write_text("not verifier evidence")
            result = index_job(job)["trials"][0]
            evidence = {item["path"]: item for item in result["verifier_artifacts"]}
            for name, content in contents.items():
                self.assertEqual(evidence["verifier/" + name]["state"], "present")
                self.assertEqual((verifier / name).read_text(), content)
            self.assertEqual(evidence["verifier/escape"]["state"], "invalid")
            self.assertEqual(result["score"], native["verifier_result"])
            self.assertIsNone(result["exception"])

    def test_invalid_result_artifact_cannot_contribute_score_or_run_facts(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            trial = job / "trial"
            trial.mkdir()
            outside = job / "outside.json"
            outside.write_text(json.dumps({
                "verifier_result": {"rewards": {"reward": 1}},
                "agent_result": {"cost_usd": 2},
                "exception_info": {"message": "outside fact"},
            }))
            (trial / "result.json").symlink_to(outside)
            result = index_job(job)["trials"][0]
            self.assertEqual(result["artifacts"]["harbor_result"]["state"], "invalid")
            self.assertEqual(result["evidence_state"], "invalid")
            self.assertIsNone(result["score"])
            self.assertIsNone(result["exception"])
            self.assertIsNone(result["cost_usd"])

    def test_compiled_config_defaults_to_one_and_preserves_explicit_concurrency(self):
        from harbor.models.job.config import JobConfig

        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.yaml"
            config.write_text("n_attempts: 1\n")
            compiled = check_config(config)
            self.assertEqual(JobConfig.model_validate(compiled).n_concurrent_trials, 1)
            config.write_text("n_concurrent_trials: 5\n")
            self.assertEqual(
                JobConfig.model_validate(check_config(config)).n_concurrent_trials, 5
            )
            for content in (
                "n_concurrent_trials: 0\n",
                "n_concurrent_trials: -1\n",
                "n_concurrent_trials: true\n",
                "n_concurrent_trials: 1.5\n",
                "n_attempts: 2\n",
                "retry: {max_retries: 2}\n",
                "orchestrator: {retry: {max_retries: 3}}\n",
            ):
                with self.subTest(content=content):
                    config.write_text(content)
                    with self.assertRaises(ValueError):
                        check_config(config)

    def test_registration_precedes_execution_and_failure_is_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config.yaml"
            config.write_text("n_attempts: 1\n")
            jobs = root / "jobs"

            def launch(command, **kwargs):
                job = jobs / command[command.index("--job-name") + 1]
                record = json.loads((job / "invocation.json").read_text())
                self.assertEqual(record["state"], "running")
                self.assertEqual(record["kind"], "paid")
                self.assertIn(str(job.parent.resolve()), command)
                snapshot = Path(command[command.index("-c") + 1])
                original = snapshot.read_bytes()
                config.write_text("n_attempts: 2\n")
                self.assertEqual(snapshot.read_bytes(), original)
                self.assertEqual(snapshot.name, record["config_snapshot"])
                return SimpleNamespace(returncode=7, wait=lambda: 7)

            with (
                patch("benchmark.run.subprocess.Popen", side_effect=launch),
                patch("benchmark.run.verify_log_mount"),
            ):
                self.assertEqual(
                    tracked_run(
                        config, jobs, "paid", {"task_ids": ["selected"], "seed": 42}
                    ),
                    7,
                )
                config.write_text("n_attempts: 1\n")
                self.assertEqual(
                    tracked_run(
                        config, jobs, "paid", {"task_ids": ["selected"], "seed": 42}
                    ),
                    7,
                )
            self.assertEqual(len(list(jobs.iterdir())), 2)
            for job in jobs.iterdir():
                record = json.loads((job / "invocation.json").read_text())
                self.assertEqual(record["exit_code"], 7)
                self.assertEqual(record["cost_status"], "unknown")
                self.assertEqual(
                    record["selection"], {"task_ids": ["selected"], "seed": 42}
                )
                self.assertTrue((job / "analysis-index.json").is_file())

    def test_unshared_logs_fail_before_harbor_starts_and_keep_invocation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config.yaml"
            config.write_text("n_attempts: 1\n")
            with (
                patch(
                    "benchmark.run.verify_log_mount",
                    side_effect=RuntimeError("unshared directory"),
                ),
                patch("benchmark.run.subprocess.Popen") as launch,
            ):
                with self.assertRaises(RuntimeError):
                    tracked_run(config, root / "jobs", "fixture")
            launch.assert_not_called()
            record = json.loads(
                next((root / "jobs").glob("*/invocation.json")).read_text()
            )
            self.assertEqual(record["state"], "failed")
            self.assertEqual(record["stage"], "preflight")

    def test_cancel_waits_for_harbor_recovery_instead_of_killing_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config.yaml"
            config.write_text("n_attempts: 1\n")
            process = MagicMock(returncode=0)
            process.poll.return_value = None
            process.wait.side_effect = [KeyboardInterrupt(), 0]
            with (
                patch("benchmark.run.verify_log_mount"),
                patch("benchmark.run.subprocess.Popen", return_value=process) as launch,
            ):
                self.assertEqual(tracked_run(config, root / "jobs", "fixture"), 130)
            self.assertTrue(launch.call_args.kwargs["start_new_session"])
            process.send_signal.assert_called_once()
            process.kill.assert_not_called()
            record = json.loads(
                next((root / "jobs").glob("*/invocation.json")).read_text()
            )
            self.assertEqual(record["state"], "cancelled")
            self.assertEqual(record["cleanup_status"], "harbor_exited")

    def test_index_preserves_missing_and_damaged_evidence_without_rewriting_trace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            trial = root / "trial"
            trace = trial / "agent/omni/state/traces/coding/session/run"
            trace.mkdir(parents=True)
            manifest = trace / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "sessionId": "session",
                        "runId": "run",
                        "status": "cancelled",
                        "completedAt": 2,
                    }
                )
            )
            replay = trace / "replay.jsonl"
            content = (
                '{"seq":1,"kind":"run.started"}\n{"seq":2,"kind":"run.cancelled"}\n'
            )
            replay.write_text(content)
            audit = trial / "artifacts/benchmark-audit/runtime-probes.jsonl"
            audit.parent.mkdir(parents=True)
            audit.write_text('{"event":"started"}\n')
            complete = index_job(root)["trials"][0]
            self.assertEqual(
                complete["artifacts"]["runtime_probes"]["state"], "present"
            )
            self.assertEqual(audit.read_text(), '{"event":"started"}\n')
            self.assertEqual(inspect_traces(trial)[0]["state"], "complete")
            self.assertEqual(complete["evidence_state"], "not_provided")
            self.assertEqual(replay.read_text(), content)
            replay.write_text(content + '{"seq":')
            index_job(root)
            self.assertEqual(inspect_traces(trial)[0]["state"], "invalid")
            self.assertEqual(replay.read_text(), content + '{"seq":')
            manifest.write_text(json.dumps({"completedAt": 2}))
            replay.write_text('{"seq":1}\n')
            self.assertEqual(inspect_traces(trial)[0]["state"], "incomplete")
            replay.unlink()
            self.assertEqual(inspect_traces(trial)[0]["state"], "incomplete")


if __name__ == "__main__":
    unittest.main()
