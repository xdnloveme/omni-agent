# ADR-0003: Godot Side-Scrolling Workshop Environment

## Status

Accepted

Gameplay geometry, ladder collision/dismount, walk-phase, visual-layer, and camera details are partially superseded by
[ADR-0005](0005-workshop-traversal-locomotion-animation.md). World, Controller, overlay,
interaction, and Session ownership decisions remain current.

## Date

2026-08-25

## Engine Compatibility

| Field                 | Value                                                                     |
| --------------------- | ------------------------------------------------------------------------- |
| Engine                | Godot 4.7.2 stable                                                        |
| Language              | GDScript                                                                  |
| Domain                | Character movement, spatial interaction, camera, and overlay UI           |
| References Consulted  | Godot 4.7 `CharacterBody2D`, `Area2D`, `Camera2D`, and signal docs        |
| Post-Cutoff APIs Used | Current Godot 4.7 physics, scene, InputMap, and camera behavior           |
| Verification Required | Pinned-engine import, world harness, real-transport flow, and manual play |

## ADR Dependencies

| Field      | Value                                                                            |
| ---------- | -------------------------------------------------------------------------------- |
| Depends On | ADR-0002 and the existing `CharacterWorkspaceController` lifecycle               |
| Enables    | Workshop movement, authored object interactions, future character/build overlays |
| Blocks     | World scripts must not acquire Agent, Session, Run, or protocol state            |

## Context

The Godot client already selects a real Agent, opens a Session, streams Runs, and cancels work. It
previously presented the task panel as the entire workspace. The next product slice needs an
independent side-scrolling environment without creating another Agent runtime or moving Session
lifecycle into scene scripts.

The environment also needs to preserve the user's position when task UI opens and closes. Treating
the task panel as navigation would incorrectly couple presentation visibility to Session ownership.

## Decision

Add one persistent `WorkshopWorld` scene under `GameRoot`. `PartnerActor` owns only movement,
gravity, ladder state, and facing. `WorkshopCameraRig` owns camera following and floor-aware
composition. `WorkshopInteractionPoint` owns only spatial availability, identity, and prompts for
the bed, sofa, workbench, and door. `WorkshopWorld` coordinates those world objects and emits
presentation-level intent signals.

`GameRoot` remains the explicit presentation composition point. It reacts to world intent by
showing a task overlay and disabling world input. It does not implement Session transitions.
`CharacterWorkspaceController` remains the sole Godot owner of selected Agent, current Session,
foreground Run, transcript, and close-before-create/return behavior.

```text
WorkshopWorld intent
  -> GameRoot presentation coordination
  -> CharacterWorkspaceController when business state changes
  -> AgentHostClient
  -> WebSocket Protocol v2
```

Closing `TaskPanel` only hides the overlay. Returning to character selection explicitly calls
`back_to_characters()` and waits for the real Session close before leaving the world.

The first environment is a 2400 × 960 treehouse room with horizontal movement, one buffered ground
jump, three walkable levels, two bounded ladders, authored furniture interactions, and bounded
camera following. Combat, multiple maps, and Build/skill-tree behavior are deferred.

Current route geometry, collision cleanup, animation phase, foot anchors, and camera ownership are
specified in [ADR-0005](0005-workshop-traversal-locomotion-animation.md). Character-specific canvas
sizes and motion resources belong to `CharacterAnimationSet`; they do not alter physics or Session
ownership. The approved layer registration is maintained in the
[foreground asset contract](../art/workshop-occlusion-asset-spec.md).

The distant environment uses a background, one shader-driven horizontally repeating cloud band,
and a transparent foreground. The sky mask excludes interiors, basement, beams, and tree trunks.
Mountains and architecture remain static. The cloud effect adds one presentation draw and no
per-frame script, particle system, physics node, or world state. Its 120-second cycle is exact at
the shader `TIME` rollover boundary.

## Alternatives Considered

### Let WorkshopWorld call AgentHostClient

Rejected because the environment would become a second business orchestrator and would duplicate
Controller ownership of Sessions and Runs.

### Close the Session when TaskPanel closes

Rejected because a UI visibility action must not destroy the active task context. It would also
reset the environment on every interaction.

### Introduce a scene router or event bus

Rejected because v1 has one world and a small explicit composition. A routing framework would add
an unproven abstraction and obscure the current ownership graph.

### Add a generic platforming or path-following framework

Rejected for ENV v1. The one approved bridge uses ordinary authored level collision and the
existing `CharacterBody2D`; it does not justify a TileMap foothold framework, `PathFollow2D`, a
second movement path, chained platforming, or a general drop-through-platform system.

## Consequences

Positive:

- The game gains spatial interaction without changing Host or Service ownership.
- Session and Run state retain one owner.
- Task UI can open and close without reloading the world or resetting the character.
- Future character information and Build panels can use the same overlay boundary.

Negative and accepted trade-offs:

- `GameRoot` coordinates selection, world, menu, and task-overlay visibility for the single world.
- INFO v1 subsequently replaced the code-drawn presentation with the approved clean treehouse
  background and anchored partner animation atlases; the world collision and interaction
  ownership in this ADR remains unchanged.
- Headless verification protects state transitions, but movement and camera feel still need manual
  play.

## Validation Criteria

- Godot 4.7.2 imports every scene without errors.
- World input can be disabled without moving the actor.
- Jumping is grounded, buffered, supports a short coyote window, and cannot double-jump.
- Ladder traversal stops at explicit top and bottom bounds and dismounts stably onto the upper
  floor.
- Main floor, upper floor, ladder bounds, exits, spawn, collision bottom, and animation foot anchors
  agree on one coordinate convention.
- Middle-floor footholds do not overlap the lower traversal band or create vertical blockers.
- The bridge produces a measurable down-and-up trajectory while the actor remains grounded.
- Holding Down into a lower dismount and then Left or Right cannot immediately re-enter the ladder.
- Workbench availability is bounded by its spatial area.
- Opening and closing the task overlay preserves the Session and actor position.
- Creating a new task replaces the Session while keeping the world and overlay open.
- Returning to character selection waits for Session closure.
- No world or UI script imports, constructs, or parses Agent runtime or protocol state.

## Related Decisions

- [`0002-godot-agent-host-client.md`](0002-godot-agent-host-client.md)
- [`../godot-workshop-environment.md`](../godot-workshop-environment.md)
- [`../godot-agent-host-client.md`](../godot-agent-host-client.md)
- [`../architecture.md`](../architecture.md)
