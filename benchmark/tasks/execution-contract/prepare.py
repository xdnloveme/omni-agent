import json
import shutil
from pathlib import Path

from benchmark.environments.runtime import prepare_environment
from harbor.models.task.config import TaskConfig

base = Path(__file__).resolve().parents[2]
image = "swebench/sweb.eval.x86_64.axios_1776_axios-4731@sha256:e75f3f2f1e91fbd09a00bd14a4c807dab210d58a5d7395b595cf65314d092bb1"


def prepare(output):
    if output.exists():
        raise ValueError("Fixture output must be new")
    for kind in ["files", "patch"]:
        task = output / kind
        for part in ["environment", "tests", "solution"]:
            (task / part).mkdir(parents=True, exist_ok=True)
        env = task / "environment"
        (env / "Dockerfile").write_text(
            f'FROM {image}\nWORKDIR /testbed\nRUN mkdir -p /mock && printf "fixture input\\n" > /testbed/input.txt\nCOPY model-server.py /mock/model-server.py\nCOPY probe-network.py /mock/probe-network.py\nCOPY entrypoint.sh /mock/entrypoint.sh\nENTRYPOINT ["bash", "/mock/entrypoint.sh"]\n'
        )
        shutil.copyfile(
            Path(__file__).with_name("model-server.py"), env / "model-server.py"
        )
        shutil.copyfile(
            Path(__file__).with_name("probe-network.py"), env / "probe-network.py"
        )
        (env / "entrypoint.sh").write_text(
            '#!/bin/bash\nset -e\nif [ "${OMNI_SMOKE_MODEL_SERVER:-}" = 1 ]; then python3 /mock/model-server.py >/mock/server.log 2>&1 & fi\nexec "$@"\n'
        )
        (env / "runtime.json").write_text(
            json.dumps(
                {
                    "version": 2,
                    "tools": [
                        {
                            "name": "node",
                            "argv_prefix": ["node"],
                            "probe_args": ["--version"],
                            "description": "Original task Node runtime",
                        },
                    ],
                },
                indent=2,
            )
        )
        (task / "instruction.md").write_text(
            "Read input.txt, write ready followed by a newline to result.txt, and write execution.json containing the current working directory as cwd and the Node version as node.\n"
        )
        (task / "solution/solve.sh").write_text("""#!/bin/bash
set -euo pipefail
printf 'ready\\n' > /testbed/result.txt
node -e 'require("fs").writeFileSync("/testbed/execution.json",JSON.stringify({cwd:process.cwd(),node:process.version}))'
""")
        required = ["result.txt", "execution.json"]
        argv = ["/usr/bin/python3", "/opt/fixture/collect.py"]
        if kind == "files":
            (env / "collect.py").write_text("""import argparse, shutil
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--workspace',type=Path,required=True)
p.add_argument('--output-dir',type=Path,required=True)
a=p.parse_args()
for name in ['result.txt','execution.json']:
 source=a.workspace/name
 if source.is_symlink(): raise ValueError('Symlink submission')
 shutil.copyfile(source,a.output_dir/name)
""")
            with (env / "Dockerfile").open("a") as f:
                f.write("COPY collect.py /opt/fixture/collect.py\n")
        if kind == "patch":
            shutil.copyfile(
                base / "taskpacks/swe/collect-submission.sh",
                env / "collect-submission.sh",
            )
            with (env / "Dockerfile").open("a") as f:
                f.write(
                    "COPY collect-submission.sh /opt/fixture/collect-submission.sh\nRUN git -C /testbed rev-parse HEAD > /opt/fixture/baseline\n"
                )
            argv = [
                "bash",
                "/opt/fixture/collect-submission.sh",
                "--baseline-file",
                "/opt/fixture/baseline",
            ]
            required = ["changes.patch"]
        config = TaskConfig().model_dump(mode="json")
        config["environment"].update(
            workdir="/testbed", network_mode="no-network", cpus=2, memory_mb=4096
        )
        config["agent"].update(timeout_sec=1800, network_mode="no-network")
        config["verifier"].update(
            environment_mode="separate",
            timeout_sec=1800,
            network_mode="no-network",
            environment={
                "network_mode": "no-network",
                "cpus": 1,
                "memory_mb": 2048,
                "build_timeout_sec": 1800,
            },
        )
        prepare_environment(
            task,
            config,
            collector_argv=argv,
            required=required,
            collector_id="fixture-" + kind + "-v1",
        )
        import yaml

        compose_path = env / "docker-compose.yaml"
        compose = yaml.safe_load(compose_path.read_text())
        compose["services"]["omni-model"] = {
            "environment": {"OMNI_SMOKE_MODEL_SERVER": "1"}
        }
        compose_path.write_text(yaml.safe_dump(compose))
        (task / "task.toml").write_text(
            TaskConfig.model_validate(config).model_dump_toml()
        )
        shutil.copyfile(base / "environments/handoff.py", task / "tests/handoff.py")
        if kind == "patch":
            shutil.copyfile(
                base / "taskpacks/swe/verifier/apply-submission.sh",
                task / "tests/apply-submission.sh",
            )
        (task / "tests/Dockerfile").write_text(
            f"FROM {image}\nCOPY . /tests/\nRUN mkdir -p /submission /logs/verifier\n"
        )
        prefix = (
            """#!/bin/bash
set -euo pipefail
test "$(ls /sys/class/net)" = lo
printf 'network_mode=none interfaces=lo\\n' > /logs/verifier/network.txt
rm -f /logs/verifier/reward.txt
python3 /tests/handoff.py validate --directory /submission --required """
            + " ".join(required)
            + "\n"
        )
        if kind == "patch":
            prefix += (
                "bash /tests/apply-submission.sh /testbed /submission/changes.patch\n"
            )
        location = "/testbed" if kind == "patch" else "/submission"
        (task / "tests/test.sh").write_text(
            prefix
            + """if node - <<'JS'
const fs = require('fs'); const assert = require('assert');
assert.equal(fs.readFileSync("""
            + json.dumps(location + "/result.txt")
            + """, 'utf8'), 'ready\\n');
const execution = JSON.parse(fs.readFileSync("""
            + json.dumps(location + "/execution.json")
            + """, 'utf8'));
assert.equal(execution.cwd, '/testbed'); assert.equal(execution.node, 'v20.20.2');
JS
then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
"""
        )


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Prepare free execution-contract tasks from shared implementations"
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.output.resolve())
