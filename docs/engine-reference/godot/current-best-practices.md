# Godot Client Practices

- Pin Godot 4.7.2 and fail explicitly on version mismatch.
- Keep `WebSocketPeer.poll()` and packet draining in `AgentHostClient._process()`.
- Use one concrete Client until a second real backend demonstrates a shared boundary.
- Wire Client, Controller, and UI explicitly from `GameRoot`; do not add an Autoload service locator.
- Keep wire validation fail-closed and reject unknown fields or Protocol versions.
- Keep movement, ladder, camera, and proximity in world nodes; publish intent instead of calling
  the Agent Client from the world.
- Treat task UI as an overlay over the current world and Session, not as Session navigation.
- Remove Host URL and Token environment values immediately after reading them.
- Let the Controller own close-before-switch Session behavior.
- Let the parent Node process own Host/Godot startup and shutdown.
- Keep engine caches under `.godot/` out of version control; keep script UID sidecars with source.
- Treat a successful headless harness as protocol/lifecycle evidence, not visual or model-output QA.
