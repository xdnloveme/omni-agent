import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from benchmark.run import index_job, tracked_run


class RunEvidenceTest(unittest.TestCase):
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
                return subprocess.CompletedProcess(command, 7)

            with patch("benchmark.run.subprocess.run", side_effect=launch):
                self.assertEqual(tracked_run(config, jobs, "paid"), 7)
                self.assertEqual(tracked_run(config, jobs, "paid"), 7)
            self.assertEqual(len(list(jobs.iterdir())), 2)
            for job in jobs.iterdir():
                record = json.loads((job / "invocation.json").read_text())
                self.assertEqual(record["exit_code"], 7)
                self.assertEqual(record["cost_status"], "unknown")
                self.assertTrue((job / "analysis-index.json").is_file())

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
            complete = index_job(root)["trials"][0]
            self.assertEqual(complete["traces"][0]["state"], "complete")
            self.assertEqual(complete["artifacts"]["omni_result"]["state"], "missing")
            self.assertEqual(replay.read_text(), content)
            replay.write_text(content + '{"seq":')
            broken = index_job(root)["trials"][0]
            self.assertEqual(broken["traces"][0]["state"], "invalid")
            self.assertEqual(replay.read_text(), content + '{"seq":')
            manifest.write_text(json.dumps({"completedAt": 2}))
            replay.write_text('{"seq":1}\n')
            self.assertEqual(
                index_job(root)["trials"][0]["traces"][0]["state"], "incomplete"
            )
            replay.unlink()
            self.assertEqual(
                index_job(root)["trials"][0]["traces"][0]["state"], "incomplete"
            )


if __name__ == "__main__":
    unittest.main()
