"""Opt-in real Linux container tests at the common handoff boundary."""

import json
import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

IMAGE = os.environ.get("BENCHMARK_TEST_IMAGE")
ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(
    IMAGE, "Set BENCHMARK_TEST_IMAGE to a prepared execution-contract image"
)
class ContainerHandoffTest(unittest.TestCase):
    def run_case(self, body):
        name = "benchmark-contract-" + uuid.uuid4().hex[:12]
        try:
            subprocess.run(
                [
                    "docker",
                    "create",
                    "--name",
                    name,
                    "--init",
                    "--platform",
                    "linux/amd64",
                    "--network",
                    "none",
                    "--entrypoint",
                    "python3",
                    IMAGE,
                    "/tmp/case.py",
                ],
                check=True,
                capture_output=True,
            )
            inspection = json.loads(
                subprocess.check_output(["docker", "inspect", name])
            )[0]
            self.assertEqual(inspection["HostConfig"]["NetworkMode"], "none")
            subprocess.run(
                [
                    "docker",
                    "cp",
                    str(ROOT / "benchmark/environments/handoff.py"),
                    name + ":/tmp/handoff.py",
                ],
                check=True,
                capture_output=True,
            )
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "case.py"
                path.write_text(
                    """import json, os, subprocess
from pathlib import Path
from handoff import collect, validate_submission, solver_processes
config=json.loads(Path('/opt/benchmark/handoff-config.json').read_text())
Path('/testbed/result.txt').write_text('ready\\n')
Path('/testbed/execution.json').write_text('{}')
"""
                    + body
                )
                subprocess.run(
                    ["docker", "cp", str(path), name + ":/tmp/case.py"],
                    check=True,
                    capture_output=True,
                )
            result = subprocess.run(
                ["docker", "start", "-a", name], capture_output=True, timeout=150
            )
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            return result.stdout.decode()
        finally:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)

    def test_residual_solver_process_is_stopped_before_submission(self):
        self.run_case("""
p=subprocess.Popen(['runuser','-u','benchmark-runner','--','sleep','120'])
collect(config, '/benchmark-audit')
p.wait(timeout=10)
assert not solver_processes(10001)
assert validate_submission('/submission',config['required'])['version']==1
""")

    def test_collection_failure_invalidates_stale_receipt(self):
        self.run_case("""
Path('/submission/handoff.json').write_text('{"version":1}')
config['collector_argv']=['/bin/false']
try: collect(config, '/benchmark-audit')
except RuntimeError: pass
else: raise AssertionError('Failure hidden')
assert not Path('/submission/handoff.json').exists()
assert json.loads(Path('/benchmark-audit/handoff.jsonl').read_text().splitlines()[-1])['event']=='failed'
try: validate_submission('/submission',config['required'])
except FileNotFoundError: pass
else: raise AssertionError('Invalid input allowed into grading')
""")

    def test_task_cannot_write_scoring_assets_or_use_external_network(self):
        self.run_case("""
command=['runuser','-u','benchmark-runner','--','bash','-c','test ! -w /submission && test ! -w /tests && test ! -r /benchmark-audit && test ! -w /opt/benchmark']
assert subprocess.run(command).returncode==0
result=subprocess.run(['runuser','-u','benchmark-runner','--','curl','--connect-timeout','3','--max-time','4','http://1.1.1.1'],capture_output=True)
assert result.returncode!=0
""")
