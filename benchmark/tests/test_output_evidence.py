import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from benchmark.adapters.omni.evidence import inspect_outputs, inspect_traces


class OutputEvidenceTests(unittest.TestCase):
    def test_relocated_complete_capture_and_missing_body(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            agent = root / "agent/omni/state/workspaces/workspace/sessions/agent"
            output = agent / "outputs/session"
            output.mkdir(parents=True)
            body = output / "record.stdout.data"
            body.write_bytes(b"saved\n")
            record = {"version": 1, "id": "record", "state": "interrupted", "parts": [{"id": "stdout", "bytes": 6, "sha256": hashlib.sha256(b"saved\n").hexdigest()}]}
            (output / "record.json").write_text(json.dumps(record))
            (agent / "session.jsonl").write_text(json.dumps({"kind": "message", "message": {"details": {"output": record}}}) + "\n")
            result = inspect_outputs(root)
            self.assertEqual(result["integrity"], "complete")
            self.assertEqual(result["captures"][0]["capture_state"], "interrupted")
            modified = {**record, "state": "complete"}
            (agent / "session.jsonl").write_text(json.dumps({"kind": "message", "message": {"details": {"output": modified}}}) + "\n")
            self.assertEqual(inspect_outputs(root)["integrity"], "incomplete")
            (agent / "session.jsonl").write_text(json.dumps({"kind": "message", "message": {"details": {"output": record}}}) + "\n")
            body.unlink()
            self.assertEqual(inspect_outputs(root)["integrity"], "incomplete")
            (output / "record.json").unlink()
            self.assertEqual(inspect_outputs(root)["integrity"], "incomplete")

    def test_malformed_native_evidence_is_reported_without_losing_other_records(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sessions = root / "agent/omni/state/workspaces/workspace/sessions/agent"
            sessions.mkdir(parents=True)
            transcript = sessions / "session.jsonl"
            for message in ([], {"message": None}, {"message": []}):
                with self.subTest(message=message):
                    transcript.write_text(json.dumps(message) + "\n")
                    result = inspect_outputs(root)
                    self.assertEqual(result["integrity"], "incomplete")
                    self.assertEqual(len(result["failures"]), 1)
                    self.assertEqual(result["failures"][0]["path"], str(transcript.relative_to(root)))

            traces = root / "agent/omni/state/traces/agent/session"
            for name, status in (("damaged", []), ("valid", "completed")):
                run = traces / name
                run.mkdir(parents=True)
                (run / "manifest.json").write_text(json.dumps({"status": status, "completedAt": 1}))
                (run / "replay.jsonl").write_text(json.dumps({"seq": 1, "kind": "run.completed"}) + "\n")
            self.assertEqual([item["state"] for item in inspect_traces(root)], ["invalid", "complete"])
