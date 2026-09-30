import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from benchmark.adapters.omni.instruction import (
    ENVIRONMENT_INPUT_MAX_BYTES,
    ROOT,
    prepare_instruction,
)


class InstructionContractTest(unittest.TestCase):
    def test_original_and_submitted_input_are_exact_and_auditable(self):
        original = "Task with Unicode: \u4fee\u590d\r\nPreserve spacing.  \n"
        rules = (ROOT / "benchmark/prompts/evaluation-rules.md").read_text()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            facts = {"cwd": "/testbed", "tools": []}
            submitted = prepare_instruction(original, output, facts)
            self.assertTrue(submitted.startswith(rules))
            self.assertEqual(
                submitted.split("--- BEGIN ORIGINAL TASK ---\n", 1)[1], original
            )
            environment = json.dumps(facts, indent=2, ensure_ascii=False) + "\n"
            self.assertIn(environment, submitted)
            manifest = json.loads((output / "instruction-manifest.json").read_text())
            for name, text in {
                "rules": rules,
                "environment": environment,
                "original": original,
                "submitted": submitted,
            }.items():
                self.assertEqual(
                    (output / f"instruction-{name}.txt").read_bytes(), text.encode()
                )
                self.assertEqual(
                    manifest["sha256"][name], hashlib.sha256(text.encode()).hexdigest()
                )
            self.assertEqual(manifest["protocol"], "evaluation-input-v4")

    def test_large_outputs_are_explicitly_omitted_without_losing_tool_declarations(
        self,
    ):
        tools = [
            {
                "name": f"tool-{i}",
                "executable": f"/task/{i}/tool",
                "probe_args": ["--version"],
                "stdout": "测" * 8000,
                "stderr": "details",
            }
            for i in range(16)
        ]
        facts = {"cwd": "/task with spaces", "tools": tools}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            submitted = prepare_instruction("Original task", output, facts)
            payload = (output / "instruction-environment.txt").read_bytes()
            section = submitted[
                len((ROOT / "benchmark/prompts/evaluation-rules.md").read_text()) :
            ]
            section = section.split("\n--- BEGIN ORIGINAL TASK ---\n", 1)[0]
            self.assertLessEqual(
                len(section.encode("utf-8")), ENVIRONMENT_INPUT_MAX_BYTES
            )
            projected = json.loads(payload)
            self.assertTrue(projected["observations_omitted"])
            self.assertEqual(len(projected["tools"]), 16)
            for original, selected in zip(tools, projected["tools"]):
                self.assertEqual(
                    selected,
                    {
                        k: v
                        for k, v in original.items()
                        if k not in {"stdout", "stderr"}
                    },
                )
            self.assertEqual(facts["tools"][0]["stdout"], "测" * 8000)
            self.assertIn("observations_omitted", submitted)
            manifest = json.loads((output / "instruction-manifest.json").read_text())
            self.assertTrue(manifest["environment_projection"]["observations_omitted"])

    def test_oversized_declarations_are_rejected_without_truncating_arguments(self):
        facts = {
            "cwd": "/task",
            "tools": [
                {
                    "name": "tool",
                    "executable": "/tool",
                    "probe_args": ["x" * ENVIRONMENT_INPUT_MAX_BYTES],
                }
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            with self.assertRaisesRegex(ValueError, "declarations exceed"):
                prepare_instruction("Task", output, facts)
            self.assertEqual(list(output.iterdir()), [])

    def test_empty_task_is_rejected_before_artifacts_are_written(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            with self.assertRaises(ValueError):
                prepare_instruction("  \n", output, {"cwd": "/testbed"})
            self.assertEqual(list(output.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
