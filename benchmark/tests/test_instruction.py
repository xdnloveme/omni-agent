import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from benchmark.adapters.harbor.agent import ROOT, prepare_instruction


class InstructionContractTest(unittest.TestCase):
    def test_original_and_submitted_input_are_exact_and_auditable(self):
        original = "Task with Unicode: \u4fee\u590d\r\nPreserve spacing.  \n"
        rules = (ROOT / "benchmark/prompts/evaluation-rules.md").read_text()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            submitted = prepare_instruction(original, output)
            self.assertEqual(
                submitted, rules + "\n--- BEGIN ORIGINAL TASK ---\n" + original
            )
            manifest = json.loads((output / "instruction-manifest.json").read_text())
            for name, text in {
                "rules": rules,
                "original": original,
                "submitted": submitted,
            }.items():
                self.assertEqual(
                    (output / f"instruction-{name}.txt").read_bytes(), text.encode()
                )
                self.assertEqual(
                    manifest["sha256"][name], hashlib.sha256(text.encode()).hexdigest()
                )
            self.assertEqual(manifest["protocol"], "evaluation-rules-v1")

    def test_empty_task_is_rejected_before_artifacts_are_written(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            with self.assertRaises(ValueError):
                prepare_instruction("  \n", output)
            self.assertEqual(list(output.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
