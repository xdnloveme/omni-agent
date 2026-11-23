# Relevant Godot Breaking Changes

The game began on Godot 4.7.2 and has no earlier Godot project to migrate. No compatibility layer is
maintained.

Only APIs used by this repository are tracked here. The 4.7.2 implementation uses:

- `WebSocketPeer.connect_to_url()`, `poll()`, packet reads, `send_text()`, and `close()`.
- `OS.get_environment()` and `OS.unset_environment()`.
- `JSON.parse_string()` and `JSON.stringify()`.
- `CharacterBody2D.move_and_slide()`, `Area2D` overlap signals, and bounded `Camera2D` following.
- Godot 4 scene and GDScript syntax.

Before changing the pinned version, run the import, protocol, and real Host harnesses and review the
official release notes. Replace obsolete usage directly; do not add multi-version branches without
an explicit distribution requirement.
