# Godot Networking Reference

## WebSocketPeer

Reference: <https://docs.godotengine.org/en/4.7/classes/class_websocketpeer.html>

`AgentHostClient` creates one `WebSocketPeer`, calls `connect_to_url()`, and calls `poll()` from the
main loop. After polling it drains all available text packets. Binary packets, malformed JSON,
unknown fields, and unsupported Protocol versions fail the connection.

The Client uses `send_text()` only after Host `ready`. It does not reconnect, replay, retry business
operations, or create a Session queue. Those omissions are deliberate Protocol v2 constraints.

## Environment handoff

Reference: <https://docs.godotengine.org/en/4.7/classes/class_os.html>

`HostConnectionConfig` reads `OMNI_AGENT_HOST_URL` and `OMNI_AGENT_HOST_TOKEN`, unsets both through
`OS.unset_environment()`, validates loopback and Token shape, and passes them to the Client. The
Token is cleared from the Client after successful authentication. GDScript strings do not guarantee
immediate physical memory erasure; this is accepted for the local single-user process model.

## JSON

Reference: <https://docs.godotengine.org/en/4.7/classes/class_json.html>

Encoding uses `JSON.stringify()`. Parsing starts with `JSON.parse_string()` and then applies strict
shape checks in `AgentHostProtocol`; successful JSON parsing alone is never treated as a valid
Protocol message.
