"""Deterministic HTTP fixture for exercising the real Omni tool chain without API spend."""

import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

CALLS = [
    ("file_read", {"file_path": "input.txt"}),
    ("file_write", {"file_path": "result.txt", "content": "ready\n"}),
    (
        "bash",
        {
            "command": 'node -e \'require("fs").writeFileSync("execution.json", JSON.stringify({cwd:process.cwd(),node:process.version}))\'',
            "sandbox_scope": {
                "write_paths": [{"path": "/testbed/execution.json", "scope": "exact"}]
            },
        },
    ),
]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        time.sleep(float(os.environ.get("OMNI_SMOKE_DELAY_SECONDS", "0")))
        index = sum(message["role"] == "tool" for message in request["messages"])
        if index < len(CALLS):
            name, arguments = CALLS[index]
            delta = {
                "role": "assistant",
                "tool_calls": [
                    {
                        "index": 0,
                        "id": f"fixture-{index}",
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(arguments)},
                    }
                ],
            }
            finish = "tool_calls"
        else:
            delta = {"role": "assistant", "content": "Fixture complete."}
            finish = "stop"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for chunk in [
            {"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
            {
                "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                "usage": {
                    "prompt_tokens": 40,
                    "completion_tokens": 10,
                    "total_tokens": 50,
                },
            },
        ]:
            self.wfile.write(
                (
                    "data: "
                    + json.dumps(
                        {
                            "id": f"fixture-{index}",
                            "object": "chat.completion.chunk",
                            "created": 1,
                            "model": "fixture",
                            **chunk,
                        }
                    )
                    + "\n\n"
                ).encode()
            )
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


HTTPServer(("127.0.0.1", 18080), Handler).serve_forever()
