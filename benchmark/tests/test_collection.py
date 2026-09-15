import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

from benchmark.adapters.harbor.agent import OmniAgent


class ArtifactCollectionTest(unittest.IsolatedAsyncioTestCase):
    async def test_failed_submission_keeps_trace_but_still_fails_the_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            failure = RuntimeError("patch too large")

            async def root_exec(environment, command):
                calls.append("stop" if command.startswith("pkill") else "mkdir")

            async def collect(*args, **kwargs):
                calls.append("collect")
                raise failure

            async def download(remote, local):
                calls.append("download")
                local.mkdir()
                (local / "stderr.log").write_text("saved diagnostic")

            agent = SimpleNamespace(
                _baseline="a" * 40,
                logs_dir=Path(directory),
                exec_as_root=root_exec,
                _exec=collect,
            )
            environment = SimpleNamespace(download_dir=download)
            with self.assertRaises(RuntimeError) as error:
                await OmniAgent._collect_artifacts(agent, environment)
            self.assertIs(error.exception, failure)
            self.assertEqual(calls, ["stop", "mkdir", "collect", "stop", "download"])
            self.assertEqual(
                (Path(directory) / "omni/stderr.log").read_text(), "saved diagnostic"
            )

            environment.download_dir = AsyncMock(side_effect=OSError("download failed"))
            with self.assertRaises(ExceptionGroup) as grouped:
                await OmniAgent._collect_artifacts(agent, environment)
            self.assertEqual(
                [type(e) for e in grouped.exception.exceptions], [RuntimeError, OSError]
            )

    async def test_failed_process_stop_does_not_collect_mutable_evidence(self):
        agent = SimpleNamespace(
            exec_as_root=AsyncMock(side_effect=RuntimeError("stop failed"))
        )
        environment = SimpleNamespace(download_dir=AsyncMock())
        with self.assertRaises(RuntimeError):
            await OmniAgent._collect_artifacts(agent, environment)
        environment.download_dir.assert_not_called()
