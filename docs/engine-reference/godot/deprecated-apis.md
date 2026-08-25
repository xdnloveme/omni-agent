# Relevant Godot Deprecated APIs

As of the 4.7.2 verification on 2026-08-26, the client intentionally avoids older WebSocket client
nodes and third-party networking plugins. It uses the current `WebSocketPeer` API documented for
Godot 4.7.

No deprecated API warning was emitted while importing the project or running the two headless
harnesses. This statement is limited to exercised project code; it is not a claim about all Godot
APIs.
