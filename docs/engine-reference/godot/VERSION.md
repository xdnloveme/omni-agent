# Godot Engine Version

| Field         | Value                                                            |
| ------------- | ---------------------------------------------------------------- |
| Engine        | Godot                                                            |
| Version       | 4.7.2 stable                                                     |
| Commit        | `ed1daf0bf`                                                      |
| Platform      | macOS development                                                |
| Last verified | 2026-08-26                                                       |
| Release       | <https://github.com/godotengine/godot/releases/tag/4.7.2-stable> |

`GameBootstrap` checks the selected executable and rejects any version that does not report
`4.7.2`. Set `OMNI_GODOT_BINARY` to an absolute executable path when Godot is not installed in the
standard macOS application path or on `PATH`.

The engine is a development prerequisite. Repository scripts do not install it and the current CLI
distribution does not bundle the game.
