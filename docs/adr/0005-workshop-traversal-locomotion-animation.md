# ADR-0005: Workshop Traversal, Locomotion, and Animation Main Chain

## Status

Accepted

## Date

2026-08-27

## Engine Compatibility

| Field                 | Value                                                                   |
| --------------------- | ----------------------------------------------------------------------- |
| Engine                | Godot 4.7.2 stable                                                      |
| Language              | GDScript                                                                |
| Domain                | Authored traversal, character locomotion, ladder transitions, animation |
| References Consulted  | Godot 4.7 `CharacterBody2D`, `AnimatedSprite2D`, collision exceptions   |
| Verification Required | Headless traversal harness and manual 60 FPS animation playtest         |

## ADR Dependencies

| Field                | Value                                                                     |
| -------------------- | ------------------------------------------------------------------------- |
| Depends On           | ADR-0003 world, Controller, overlay, and interaction ownership            |
| Partially Supersedes | ADR-0003 gameplay geometry, ladder collision, dismount, and walk phase    |
| Extended By          | The level-composition revision in this ADR's Decision section             |
| Does Not Change      | Agent, Session, Host, Protocol, overlay, interaction, or motion ownership |

## Context

The approved Workshop raster and the previous invisible geometry diverged. The lower level had an
unexpected blocker, the bridge used a separate surface that could drift from adjacent platforms,
and ladder traversal disabled every world collision before directly changing actor position during
dismount. Character presentation also selected walk frames inside `PartnerActor` and expanded six
distinct poses into an apparent eight-frame cycle by repeating frames. These are ownership defects,
not isolated coordinate defects: patching individual points would retain multiple geometry and
animation sources of truth.

## Decision

Replace the previous paths with one chain:

```text
WorkshopTraversalMap
  -> WalkSurface2D / LadderRoute2D
  -> PartnerActor / CharacterBody2D
  -> PartnerAnimator
  -> CharacterAnimationSet
```

`WalkSurface2D.surface_points` is the only editable walk-surface data. Its one-way
`CollisionPolygon2D` and debug line are derived from the same points during editor changes and scene
initialization. Each route is bounded by its visible architecture. The bridge sag is part of the
upper route instead of a separate collision body. The upper route ends at the painted platform;
visible guard rails at both endpoints own matching blockers, replacing the earlier natural-fall
decision after playtest showed that falling through a painted rail violated visual semantics.
Sampling outside an authored x-range returns no surface instead of clamping to an endpoint.

Each `LadderRoute2D` owns its center line, endpoints, and exactly two connected
surfaces. Entering a ladder adds collision exceptions only for those surfaces. A single idempotent
cleanup path removes the exceptions for normal exit, jump-away, reset, workspace leave,
presentation change, invalid route, and scene destruction. Overlay input locking pauses traversal;
it does not silently destroy ladder state.

`PartnerActor` is the only physical-position authority. Ground, air, and climb movement use velocity
and `move_and_slide()`. Ladder entry requires grounded contact within the authored two-pixel
horizontal tolerance, then aligns the actor to the center line. Climb velocity is bounded to the
route endpoint; exit restores connected-surface collisions and floor snap without an exit curve or
position tween. A lifecycle reset may place the actor at the authored spawn marker.

Ground movement uses `MOTION_MODE_GROUNDED`, `floor_constant_speed`, and bounded
`floor_snap_length`. The actor applies gravity; overlap areas publish availability only. Ladder
detection padding may extend beyond an endpoint without changing the physical climb path.

`PartnerAnimator` consumes motion state, actual displacement, velocity, and facing. It may select
and phase `AnimatedSprite2D`, but cannot modify actor position, velocity, or collision. Ground walk
phase advances by actual travelled distance. `CharacterAnimationSet` owns frames, its source cell,
foot anchor, visual scale, stride, and declared contact region. All presentations use this same
contract, while source resolution is allowed to differ per character.

The production male and female characters use the animation resources listed in
[Production characters and art](../godot-workshop-environment.md#production-characters-and-art).
Frame counts, source canvases, and contact anchors belong to those resources rather than a separate
ADR specification. Offline asset QA checks distinct motion keys, stable clothing and silhouette,
complete framing, and the shared declared foot baseline. Manual review remains the visual-quality
gate; automated resource checks cannot certify motion quality.

Walk and climb timing are distance-driven. Walk phase accumulates grounded physical displacement,
including slopes and the bridge arc. Climb phase accumulates signed vertical travel, so downward
movement reverses the authored sequence and stopping on a ladder freezes its pose. Idle plays the
authored idle loop. The [v76 production notes](../godot-workshop-environment.md#rose-mage-v76)
define the approved female jump, idle boundaries, and accepted limitations.

The reusable walk-phase contract is:

```text
travelled = grounded ? actual_displacement.length() : 0
cycle_distance = fmod(cycle_distance + travelled, stride_pixels)
frame = floor(cycle_distance / stride_pixels * frame_count)
```

`actual_displacement` is measured after `move_and_slide()`. Input magnitude, requested velocity,
frame rate, and the background raster never determine animation phase. This keeps foot cadence tied
to physical travel and allows each `CharacterAnimationSet` to tune only its authored stride.
Frame count, foot anchor, visual scale, horizontal stride, and climb stride belong to each
`CharacterAnimationSet`; other characters may retain provisional frame counts until their own art
pass without creating a second runtime path.

The Workshop visual and gameplay spaces are independent but editor-aligned. The
[foreground asset contract](../art/workshop-occlusion-asset-spec.md) owns layer registration and
z-order: rails and the bridge contact lip are in front of the actor; rope decoration is behind it.
These layers own no collision. Rectangular scenery crops and actor-specific z or position fixes
are prohibited. `WorkshopTraversalMap` owns three surfaces, two ladders, visible blockers, spawn,
and out-of-bounds recovery. Ladder art is a child of its route, so visual and traversal coordinates
share the same owner.

Camera ownership moves from `PartnerActor` to `WorkshopCameraRig`. The rig reads actor position but
cannot mutate it. Horizontal composition is clamped to the world, while vertical composition
smoothly shifts from `y=450` on upper/middle floors to `y=510` on the lower floor. This preserves
roughly 104 pixels below the lower walk surface without changing movement or route coordinates.

## Alternatives Considered

### Patch the old rectangles and markers

Rejected because it retains duplicated floor, bridge, ladder, and exit coordinates and does not
resolve ownership.

### Use `PathFollow2D` for the actor

Rejected because it would create a second position authority alongside `CharacterBody2D` and make
jump, collision, and floor contact ambiguous.

### Disable the actor collision mask while climbing

Rejected because unrelated walls and surfaces would be ignored. Per-body collision exceptions have
the required scope and deterministic cleanup.

### Let individual animation frames or routes correct foot placement with authored offsets

Rejected because per-frame or per-route offsets would create a second authored contact source. Every
frame must conform to one foot anchor instead. A small physics-derived visual-root correction is
different: the actor measures the ground directly below its foot center and supplies the capsule's
slope-contact gap to the Animator. This changes presentation only, never physics or route geometry.

## Consequences

Positive:

- Route editing, collision, and debug visualization share one source.
- Three floors, the bridge, and two staggered ladders use one physical movement path.
- Ladder cleanup has one owner and cannot leave a global collision-mask mutation behind.
- Animation assets and physical motion can evolve independently behind an explicit contract.
- Capsule slope contact no longer lifts the visible feet above curved surfaces; a downward ground
  probe corrects only the rendered root while the `CharacterBody2D` remains authoritative.
- Visual layers, gameplay routes, and camera composition now have separate owners.
- A route cannot silently continue beyond visible architecture through endpoint clamping.

Negative and accepted trade-offs:

- The single Workshop scene owns authored point arrays directly; a multi-map route-resource layer is
  deferred until a second map proves the need.
- Visual smoothness still requires manual 60 FPS evidence; structural tests cannot certify taste.
- Character atlases have different source resolutions and frame counts; memory cost must be
  assessed against the actual production resources when replacing artwork.

## Performance Constraints

- Derived surface collision is built only for editor changes and scene initialization.
- Runtime movement never samples the background image or rebuilds route geometry.
- `PartnerAnimator` performs no image reads and allocates no per-frame collections.
- Ground adhesion uses one `RayCast2D` query for the active grounded partner; it is disabled
  semantically during air and ladder states and is capped at eight pixels.
- Debug route drawing is disabled by default.
- Background, cloud, upper foreground, and edge foliage are bounded to one draw each; the cloud
  mask is 1200 × 480 and both foreground assets are registered 2400 × 960 RGBA images. The upper
  foreground is a direct layer rather than a runtime matte replay; edge foliage has no hard
  rectangular boundary in the playable lower band.
- Normal rendering and traversal perform no runtime texture read or route rebuild. Optional F8
  debug drawing may inspect ladder texture bounds; it never feeds movement or animation.
- Target locomotion plus animation CPU cost is below 0.2 ms per frame for the one active partner,
  measured manually in the Godot profiler.

## Validation Criteria

- Upper, middle, and lower routes span only their authored visible bounds; the lower route has no
  unexpected wall.
- The upper route ends at `x=1778`; the right endpoint blocker is colocated with the visible terminal
  post. The jumpable endpoint blocker and visible post share a 64-pixel height. The front handrail
  occludes the actor through the registered RGBA foreground. Rail gaps
  remain transparent and both bridge joins are seam-checked. Runtime image analysis and rectangular
  scenery crops are prohibited.
- The bridge produces a continuous down-and-up grounded trajectory.
- The bridge route occupies the painted plank span at `x=1088..1244`; tests do not validate a surrogate
  curve elsewhere in the room.
- The two ladders are independent, offset, bidirectional, and ignore only their connected surfaces.
- Grounded normal movement can discover each ladder at both endpoints; detection padding does not
  alter the route endpoints.
- Climb velocity reaches the route endpoint before exit restores collisions and floor snap.
- All cleanup entries remove temporary collision exceptions exactly once.
- The actor origin and animation foot anchor use the same foot-center convention.
- Across the bridge, the rendered foot baseline must remain within 1.0 pixel of `UpperSurface`;
  the test must also observe non-zero slope compensation so a capsule regression cannot pass by
  validating only flat ground.
- All presentations resolve a `CharacterAnimationSet` and the Animator never mutates physics.
- Production motion keys remain distinct, idle uses the authored loop, and walk/climb phase
  changes only with physical travel.
- Visual quality is reported separately from automated structural verification.
- Ladder route and ladder art share one local coordinate system.
- The world-owned camera reaches the lower-floor composition target without moving the actor.
- Out-of-bounds recovery clears traversal state before restoring the authored spawn.

## Related Decisions

- [`0003-godot-workshop-environment.md`](0003-godot-workshop-environment.md)
- [`0004-godot-character-information.md`](0004-godot-character-information.md)
- [`../godot-workshop-environment.md`](../godot-workshop-environment.md)
- [`../architecture.md`](../architecture.md)

## Engine API references

- [CharacterBody2D](https://docs.godotengine.org/en/4.7/classes/class_characterbody2d.html)
- [CollisionPolygon2D](https://docs.godotengine.org/en/4.7/classes/class_collisionpolygon2d.html)
- [Area2D](https://docs.godotengine.org/en/4.7/classes/class_area2d.html) and [overlap signals](https://docs.godotengine.org/en/4.7/tutorials/physics/using_area_2d.html)
- [Camera2D](https://docs.godotengine.org/en/4.7/classes/class_camera2d.html)

Before changing the pinned engine, import the project and run the
[workshop verification](../godot-workshop-environment.md#verification). Replace obsolete API usage
directly rather than adding a multi-version compatibility path.
