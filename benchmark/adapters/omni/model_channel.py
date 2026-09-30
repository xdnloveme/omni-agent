"""Own the isolated model process lifecycle using native Harbor service operations."""

import asyncio
import base64
from contextlib import asynccontextmanager
import json
import shlex

SERVICE = "omni-model"
SOCKET = "/run/omni-model/session.sock"


@asynccontextmanager
async def model_channel(
    environment, *, config_file, providers_file, credential_env, key, logs_dir, agent_id
):
    # Service-local stdin replacement: native service_exec has no upload/stdin API.
    # Data travels as an exec environment value, never through the solver filesystem.
    payload = base64.b64encode(
        json.dumps(
            {
                "config.json": config_file.resolve().read_text(),
                "providers.json": providers_file.resolve().read_text(),
            }
        ).encode()
    ).decode()
    setup = """import base64,json,os
from pathlib import Path
root=Path('/home/benchmark-runner/model')
root.mkdir(mode=0o700)
os.chown(root,10001,10001)
for name,content in json.loads(base64.b64decode(os.environ['MODEL_FILES'])).items():
 p=root/name;p.write_text(content);p.chmod(0o600);os.chown(p,10001,10001)
os.chown('/run/omni-model',10001,10001)
os.chmod('/run/omni-model',0o700)
"""
    result = await environment.service_exec(
        "python3 -c " + shlex.quote(setup),
        service=SERVICE,
        user="root",
        env={"MODEL_FILES": payload},
        timeout_sec=15,
    )
    if result.return_code:
        raise RuntimeError("Isolated model configuration failed")
    node = shlex.join(
        [
            "/opt/omni-node/bin/node",
            "--import",
            "/opt/omni/node_modules/tsx/dist/loader.mjs",
            "/opt/omni/apps/omni/src/model-execution-entry.ts",
            "--socket",
            SOCKET,
            "--agent",
            agent_id,
            "--state-dir",
            "/home/benchmark-runner/model/state",
            "--config-file",
            "/home/benchmark-runner/model/config.json",
            "--providers-file",
            "/home/benchmark-runner/model/providers.json",
            "--ready-file",
            "/home/benchmark-runner/model/ready",
        ]
    )
    command = "dbus-run-session -- bash -c " + shlex.quote(
        'printf "" | gnome-keyring-daemon --unlock --components=secrets >/dev/null && exec '
        + node
    )
    process = asyncio.create_task(
        environment.service_exec(
            command,
            service=SERVICE,
            user="benchmark-runner",
            env={"HOME": "/home/benchmark-runner", credential_env: key},
        )
    )

    async def ready():
        probe = """import time
from pathlib import Path
for _ in range(150):
 if Path('/home/benchmark-runner/model/ready').is_file(): break
 time.sleep(.1)
else: raise RuntimeError('Model channel startup deadline exceeded')
"""
        result = await environment.service_exec(
            "python3 -c " + shlex.quote(probe),
            service=SERVICE,
            user="root",
            timeout_sec=20,
        )
        if result.return_code:
            raise RuntimeError("Isolated model channel did not become ready")

    readiness = asyncio.create_task(ready())
    completed = False
    try:
        done, _ = await asyncio.wait(
            [process, readiness], return_when=asyncio.FIRST_COMPLETED
        )
        if process in done:
            result = await process
            raise RuntimeError(
                "Isolated model process exited before connection: "
                + str(result.return_code)
            )
        await readiness
        yield SOCKET
        completed = True
    finally:
        readiness.cancel()
        await asyncio.gather(readiness, return_exceptions=True)
        # Give the disconnected provider stream time to acknowledge cancellation.
        # An unresponsive server is still stopped through Harbor, never left alive.
        settled = process.done()
        if completed:
            try:
                await asyncio.wait_for(asyncio.shield(process), timeout=5)
                settled = True
            except Exception:
                settled = process.done()
        stopped = False
        try:
            await environment.stop_service(SERVICE)
            stopped = True
        finally:
            if not stopped:
                process.cancel()
            outcomes = await asyncio.gather(process, return_exceptions=True)
            outcome = outcomes[0]
            # Provider payloads/credentials are never diagnostic artifacts here.
            receipt = {
                "service": SERVICE,
                "stopped": stopped,
                "settled_before_stop": settled,
            }
            if isinstance(outcome, BaseException):
                receipt["exec_error_type"] = type(outcome).__name__
            else:
                receipt["return_code"] = outcome.return_code
            (logs_dir / "model-process.json").write_text(
                json.dumps(receipt, indent=2) + "\n"
            )
        if completed and (
            not settled
            or isinstance(outcome, BaseException)
            or outcome.return_code != 0
        ):
            raise RuntimeError("Isolated model process did not close cleanly")
