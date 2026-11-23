# Godot Workshop Environment

`WorkshopWorld` is the Godot side-scrolling presentation around the real Agent Client.
It does not own Agents, Sessions or Runs. See [the Host client contract](godot-agent-host-client.md)
for protocol and Session behavior, and [ADR-0005](adr/0005-workshop-traversal-locomotion-animation.md)
for traversal ownership and the reasons behind it.

## Run and controls

```bash
pnpm game
```

Selecting a partner opens a real Session before entering the workshop.

| Input                 | Behavior                                 |
| --------------------- | ---------------------------------------- |
| A / D or Left / Right | Move the partner                         |
| W / S or Up / Down    | Climb while overlapping the ladder       |
| Space                 | Jump from the ground or away from ladder |
| E                     | Use the nearest authored interaction     |
| P / click partner     | Open or close character information      |
| F11 / menu fullscreen | Toggle fullscreen and restore the window |
| Esc                   | Close the top overlay or open/close menu |

Jumping has an input buffer and coyote window; releasing Space early reduces jump height.
There is no double-jump. Walk to a ladder's center before climbing: entry and exit retain
that vertical axis rather than pulling the actor sideways. Releasing climb input pauses
physical travel and animation together. Landing and ladder-top settling do not block new input.

## World boundaries

The 2400 × 960 world uses authored surfaces, ladders, blockers, and recovery in
`WorkshopTraversalMap`. `PartnerActor` owns physical position; `PartnerAnimator` consumes motion
without changing physics or scale. Geometry, collision cleanup, slope contact, animation timing,
and camera ownership are defined once in
[ADR-0005](adr/0005-workshop-traversal-locomotion-animation.md).
World nodes emit presentation intent; they never access the Host client or own Sessions.

## Production characters and art

`catalog.tres` maps Agent IDs to presentation resources, without restricting Agent discovery.
Unknown Agents reuse the amber mage artwork with a generic role and their Host-provided name.
Production resources do not depend on `tests/` or previews.

- `coding.tres` selects the amber mage: 512px frames, foot anchor `(256, 464)`, scale `0.34`,
  eight-frame idle, four-key walk/climb, nine-frame climb-top and four-frame standing handoff.
  Walk stride is 136px and climb stride 120px. Back-carried equipment follows the authored pose.
- `financial-analysis.tres` selects the rose mage and its approved v76 jump, described below.
- Each `CharacterAnimationSet` owns source size, anchor, scale, stride, phase ranges and equipment
  poses. Character portraits and the information panel reuse these approved resources.

The scene separates background, masked clouds, route-owned ladders, actors, rails and edge foliage.
Decorative layers own no collision. The upper rails use true alpha with open bed/ladder lanes;
the bridge deck is separate and its decorative ropes remain behind the actor.
The cloud shader uses one masked layer with a 120-second cycle, without per-frame script state.

The [offline builder and its inputs](../scripts/workshop-layer-sources/README.md) reproduce the
rails, bridge and rope decoration, using the approved backplate without rewriting it. Other
textures are standalone production assets. The [character-information contract](character-info-ux.md)
owns the dossier layout, art rules, and UI assets.

### Rose mage v76

The production set keeps 32 idle, 24 walk, and 47 climb frames; jump uses 33 v76 frames. Jump F0
and F28–F32 reuse the formal idle texture. Runtime scale stays 0.34, walk speed 128 px/s, jump
preparation 0.12 s, and landing recovery 0.24 s. Physical motion drives animation phases; no
per-frame scaling or body deformation is applied. `CharacterMotionHarness` and
`WorkshopWorldHarness` protect motion handoffs and the exact idle boundaries.

Accepted limits: interpolation remains visible around F17/F19/F23 at close zoom. Sustained 2.15x
focus during cross-platform falls can temporarily crop the feet while the camera catches up;
foreground occlusion remains near the left map edge. Normal Main conversation focus locks movement.
Source footage and review recordings are archived outside the source tree.
Production asset paths are stable and omit iteration suffixes; v76 identifies the approved
animation in this acceptance record, while Git tracks subsequent file revisions.

To roll back the jump, take `resources/characters/rose-mage-animations.tres`,
`resources/characters/rose-mage-animation-set.tres`, and `resources/movement/rose-mage-locomotion.tres`
from commit `8d8e3b8b` under `apps/omni-game/`, plus that commit's
`assets/characters/world/rose-mage-v1/animation-atlas.png`. Restore the atlas at the current
`assets/characters/world/rose-mage/animation-atlas.png` path and update the restored resources'
`rose-mage-v1/` references to `rose-mage/`. The character configuration already points to the
stable resource paths. The old atlas is required because the current atlas no longer contains
the four pre-v76 jump frames.

## Work, rest and leaving

The workbench opens the existing task flow. Closing the conversation preserves the Session,
Run, draft and reading position. Moving or jumping after collapse releases the seated pose
without swallowing that input or cancelling the Run. Work animation plays only while running.
The workstation marker remains inspectable after walking away; inspecting it does not reseat
or resubmit. Completed, failed and cancelled outcomes remain distinct until acknowledged,
replaced by a new Run, or cleared with the Session. The Controller remains their source of truth.

Middle bed, upper bed and sofa switch directly to character-specific resting artwork.
They preserve the standing contact and fixed furniture frame; beds also show snore bubbles.
E, movement or jump wakes the actor. Rest is rejected during an active Run and never cancels it.
Characters without the required rest art cannot enter that pose.

Activating an interaction dismisses its large prompt for the current overlap while retaining
the small E marker. Re-entry or a fresh workspace restores the prompt; opening an overlay does not.
The menu and door use the same Session-close flow to return to selection. A running task must
settle before leaving. Closing a presentation overlay alone does not close a Session.

## Display limits

The authored viewport is 1440 × 900. `canvas_items` with `expand` adds coverage at wider aspects
without stretching characters. Camera bounds prevent unpainted space from appearing.
`GameDisplay` owns F11/fullscreen and restores the current window rectangle, including when
text input has focus. Display preferences are not persisted across launches.

World art uses linear filtering. The 1983 × 793 backplate maps to the 2400 × 960 world;
conversation focus magnifies it by 2.15. This is not native 4K close-up art.
The bedroom detail plate improves one room only. Other operating systems and exported builds
still require their own graphical acceptance.

## Verification

```bash
pnpm run verify:game
pnpm run verify:game --visual
```

The standard command runs protocol, Client/Controller lifecycle, permission settlement,
world traversal/recovery, occlusion, camera/layout, furniture and information-panel checks.
`CharacterMotionHarness` also exercises both registered mages through actual input and physics:
24 jump cases per character, phase/landing/idle handoffs, fixed body transform, equipment sync,
both ladders and their interruption cases, and native idle/blink playback.
`WorkshopWorldHarness` checks that the rose jump's initial and settled textures equal formal idle.

`--visual` adds actual selection clicks and both characters in the rendered Main scene through
an authenticated local Host with a deterministic Run fixture. Screenshots are disposable output
under the ignored `tests/evidence/` directory. The final check uses the real Host and AgentService
to open/create/close Sessions in an isolated workspace; it never calls a remote model.
The Main capture process clears physical action bindings and uses scripted actions/clicks so
shared-desktop keys cannot change the scenario. It checks that fullscreen preserves furniture
occupancy and contact before one wake click. Other harnesses and normal gameplay retain their bindings.

For native F11/menu fullscreen and window-restoration checks, run `DisplayHarness.tscn` with a
graphical Godot display. Its standard headless run checks layout only. Main and the retained
release recordings provide visual inspection; headless success does not certify animation feel,
model output or arbitrary display sizes.

Build/skill tree, inventory, work history, combat, additional maps and audio remain deferred.
