import argparse
import asyncio
import json
import ipaddress
import shlex
import socket
import struct
import subprocess
from pathlib import Path
from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.task.config import EnvironmentConfig, NetworkPolicy, NetworkMode
from harbor.models.trial.paths import TrialPaths

REPOSITORY = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(
    description="Exercise native Harbor network policy without a model or API key."
)
parser.add_argument("--output-dir", type=Path, required=True)
ROOT = parser.parse_args().output_dir.resolve()


async def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    allow = NetworkPolicy(
        network_mode=NetworkMode.ALLOWLIST, allowed_hosts=["ark.cn-beijing.volces.com"]
    )
    env = DockerEnvironment(
        environment_dir=REPOSITORY / "benchmark/tasks/isolation-probe/environment",
        environment_name="omni-i0-network",
        session_id="omni-i0-network",
        trial_paths=TrialPaths(ROOT),
        task_env_config=EnvironmentConfig(
            docker_image="swebench/sweb.eval.x86_64.axios_1776_axios-4731@sha256:e75f3f2f1e91fbd09a00bd14a4c807dab210d58a5d7395b595cf65314d092bb1",
            cpus=2,
            memory_mb=2048,
        ),
        network_policy=NetworkPolicy(network_mode=NetworkMode.PUBLIC),
        phase_network_policies=[allow],
    )
    results = []

    async def probe(name, cmd):
        r = await env.exec(cmd, user="nobody", timeout_sec=20)
        item = {"name": name, **r.model_dump()}
        results.append(item)
        (ROOT / "results.json").write_text(json.dumps(results, indent=2) + "\n")
        print(json.dumps(item), flush=True)

    server = """from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path == '/redirect':
   self.send_response(302); self.send_header('Location','https://github.com'); self.end_headers()
  else:
   self.send_response(200); self.end_headers(); self.wfile.write(b'OMNI_CONTROL_CANARY')
HTTPServer(('0.0.0.0',19091), Handler).serve_forever()
"""
    image = "swebench/sweb.eval.x86_64.axios_1776_axios-4731@sha256:e75f3f2f1e91fbd09a00bd14a4c807dab210d58a5d7395b595cf65314d092bb1"
    subprocess.run(
        [
            "docker",
            "run",
            "-d",
            "--name",
            "omni-i2-host-control",
            "--network",
            "host",
            image,
            "python3",
            "-c",
            server,
        ],
        check=True,
        capture_output=True,
    )
    try:
        await env.start(force_build=False)
        await probe(
            "public_control",
            'curl --noproxy "*" -sSI --max-time 10 -o /dev/null -w "%{http_code}" https://github.com',
        )
        await probe(
            "ipv6_public_control",
            'curl -6 --noproxy "*" -sSI --max-time 5 https://example.com',
        )
        resolved_github = await env.exec(
            "getent ahostsv4 github.com", user="nobody", timeout_sec=10
        )
        github_address = str(ipaddress.ip_address(resolved_github.stdout.split()[0]))
        r = await env.exec("cat /proc/net/route")
        gateway = next(
            socket.inet_ntoa(struct.pack("<L", int(line.split()[2], 16)))
            for line in r.stdout.splitlines()[1:]
            if line.split()[1] == "00000000"
        )
        url = f"http://{gateway}:19091"
        await probe("host_public_control", f'curl --noproxy "*" -sS --max-time 5 {url}')
        await env.exec(
            "python3 -c " + shlex.quote(server) + " >/tmp/control.log 2>&1 &"
        )
        await probe(
            "redirect_control",
            'curl --noproxy "*" --retry 3 --retry-connrefused --retry-delay 1 -sS -D - --max-time 5 http://127.0.0.1:19091/redirect',
        )
        await env.set_network_policy(allow)
        await probe(
            "redirect_follow",
            'curl --noproxy "*" -LsS --max-time 10 http://127.0.0.1:19091/redirect',
        )
        await probe("host_gateway", f'curl --noproxy "*" -sS --max-time 5 {url}')
        await probe(
            "host_http_proxy",
            f"http_proxy={url} no_proxy= curl -sS --max-time 5 http://github.com",
        )
        await probe(
            "host_https_proxy",
            f"HTTPS_PROXY={url} NO_PROXY= curl -sS --max-time 5 https://github.com",
        )

        await probe(
            "model_host",
            'curl --noproxy "*" -sSI --max-time 10 -o /dev/null -w "%{http_code}" https://ark.cn-beijing.volces.com',
        )
        await probe(
            "github_curl",
            'curl --noproxy "*" -sSI --max-time 10 -o /dev/null -w "%{http_code}" https://github.com',
        )
        await probe(
            "patch_curl",
            'curl --noproxy "*" -sSI --max-time 10 -o /dev/null -w "%{http_code}" https://patch-diff.githubusercontent.com/raw/axios/axios/pull/4731.diff',
        )
        await probe(
            "host_header",
            'curl --noproxy "*" -sS --max-time 10 -H "Host: ark.cn-beijing.volces.com" -o /dev/null -w "%{http_code}" http://example.com',
        )
        await probe(
            "sni_destination",
            'curl --noproxy "*" -ksS --max-time 10 --connect-to ark.cn-beijing.volces.com:443:github.com:443 -H "Host: github.com" -o /dev/null -w "%{http_code}" https://ark.cn-beijing.volces.com',
        )
        await probe(
            "python_https",
            "python3 -c 'import urllib.request; urllib.request.urlopen(\"https://github.com\", timeout=10)'",
        )
        for name, command in (
            (
                "github_ipv4_direct",
                f'curl --noproxy "*" -ksSI --max-time 5 https://{github_address}',
            ),
            (
                "github_ipv6",
                'curl -6 --noproxy "*" -sSI --max-time 5 https://github.com',
            ),
            (
                "raw_content",
                'curl --noproxy "*" -sSI --max-time 5 https://raw.githubusercontent.com',
            ),
            (
                "search",
                'curl --noproxy "*" -sSI --max-time 5 https://www.google.com/search?q=axios',
            ),
            (
                "alternative_port",
                'curl --noproxy "*" -sSI --max-time 5 https://github.com:8443',
            ),
            (
                "sidecar_proxy",
                "HTTPS_PROXY=http://127.0.0.1:12345 NO_PROXY= curl -sSI --max-time 5 https://github.com",
            ),
            (
                "sidecar_http_proxy",
                "http_proxy=http://127.0.0.1:12345 no_proxy= curl -sSI --max-time 5 http://github.com",
            ),
            (
                "control_assets",
                "set -e; test ! -S /var/run/docker.sock; test ! -e /opt/egress-sidecar/allowlist.txt; test ! -e /proc/1/root/opt/egress-sidecar/allowlist.txt; awk '/CapEff|NoNewPrivs/ {print}' /proc/self/status",
            ),
        ):
            await probe(name, command)
        resolved = await env.exec(
            "getent ahostsv4 ark.cn-beijing.volces.com", user="nobody", timeout_sec=10
        )
        address = str(ipaddress.ip_address(resolved.stdout.split()[0]))
        await env.stop_service("harbor-docker-egress-control-sidecar")
        await probe(
            "sidecar_stopped",
            'curl --noproxy "*" -sSI --max-time 10 -o /dev/null -w "%{http_code}" https://ark.cn-beijing.volces.com',
        )
        await probe(
            "sidecar_stopped_cached_address",
            'curl --noproxy "*" -sSI --max-time 10 '
            f"--resolve ark.cn-beijing.volces.com:443:{address} "
            '-o /dev/null -w "%{http_code}" https://ark.cn-beijing.volces.com',
        )
        observed = {item["name"]: item for item in results}
        assert observed["public_control"]["return_code"] == 0, "Public control failed"
        assert observed["model_host"]["return_code"] == 0, "Model host unreachable"
        assert "OMNI_CONTROL_CANARY" in observed["host_public_control"]["stdout"]
        assert "302" in observed["redirect_control"]["stdout"]
        assert observed["control_assets"]["return_code"] == 0
        for name in (
            "redirect_follow",
            "host_gateway",
            "host_http_proxy",
            "host_https_proxy",
            "github_curl",
            "patch_curl",
            "python_https",
            "github_ipv4_direct",
            "raw_content",
            "search",
            "alternative_port",
            "sidecar_proxy",
            "sidecar_http_proxy",
            "sidecar_stopped",
            "sidecar_stopped_cached_address",
        ):
            assert observed[name]["return_code"] != 0, (
                f"Unexpected network access: {name}"
            )
        ipv6_control = observed["ipv6_public_control"]["return_code"] == 0
        if ipv6_control:
            assert observed["github_ipv6"]["return_code"] != 0
        (ROOT / "coverage.json").write_text(
            json.dumps(
                {
                    "scope": "current dedicated Docker deployment",
                    "ipv6": "blocked"
                    if ipv6_control
                    else "unverified: public control unavailable",
                    "exclusions": [
                        "DNS/ICMP covert channels",
                        "exhaustive protocol/proxy variants",
                    ],
                    "probe_count": len(results),
                },
                indent=2,
            )
            + "\n"
        )
    finally:
        await env.stop(delete=True)
        subprocess.run(
            ["docker", "rm", "-f", "omni-i2-host-control"],
            check=True,
            capture_output=True,
        )


asyncio.run(main())
