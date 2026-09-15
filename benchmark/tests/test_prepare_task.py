import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from benchmark.adapters.harbor.prepare_task import TASK_ID, prepare
from harbor.models.task.config import TaskConfig


class PrepareTaskContractTest(unittest.IsolatedAsyncioTestCase):
    async def test_new_task_keeps_upstream_inputs_and_uses_its_own_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            (source / "tests").mkdir(parents=True)
            (source / "solution").mkdir()
            (source / "task.toml").write_text("")
            (source / "instruction.md").write_bytes(b"Task\r\nunchanged\n")
            (source / "tests/test.sh").write_bytes(b"#!/bin/bash\necho official\n")
            (source / "tests/config.json").write_text(
                json.dumps({"base_commit": "a" * 40})
            )
            (source / "solution/solve.sh").write_text("echo solution\n")
            task_id = TASK_ID.model_copy(
                update={"path": TASK_ID.path.parent / "other__repo-1"}
            )
            image = "example/repo@sha256:" + "b" * 64
            downloaded = SimpleNamespace(
                results=[SimpleNamespace(path=source, content_hash="source-hash")]
            )
            output = root / "derived"
            with patch(
                "benchmark.adapters.harbor.prepare_task.TaskClient.download_tasks",
                new=AsyncMock(return_value=downloaded),
            ) as download:
                await prepare(output, task_id, image)
                download.assert_awaited_once_with([task_id])
            config = TaskConfig.model_validate_toml((output / "task.toml").read_text())
            self.assertEqual(config.environment.docker_image, image)
            self.assertEqual(config.verifier.environment_mode, "separate")
            self.assertEqual(
                (output / "tests/Dockerfile").read_text().splitlines()[0],
                "FROM " + image,
            )
            self.assertEqual(
                (output / "tests/upstream-test.sh").read_bytes(),
                (source / "tests/test.sh").read_bytes(),
            )
            self.assertEqual(
                (output / "instruction.md").read_bytes(),
                (source / "instruction.md").read_bytes(),
            )
            self.assertEqual(
                json.loads((output / "derivation.json").read_text())["source"]["path"],
                str(task_id.path),
            )
            with self.assertRaises(ValueError):
                await prepare(output, task_id, image)
