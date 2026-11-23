# ADR-0004: Godot Character Information Visual Slice

## Status

Accepted for INFO v1.

## Context

The workshop now has three real overlays: menu, task, and character information. The selected
Agent and Session already have a single owner in `CharacterWorkspaceController`, while the game
needs Agent-specific portraits and titles that are presentation-only. Keeping independent window
booleans or placing visual mappings in the Controller would create duplicate overlay state or mix
business availability with art direction.

The repository has approved visual mockups but no full Game Concept or Art Bible. INFO v1 therefore
needs a deliberately scoped visual gate rather than implying that one UI slice defines all future
production art.

## Decision

- `GameRoot` owns one `NONE | MENU | TASK | CHARACTER_INFO | PERMISSION` overlay state and all overlay input
  locking.
- `CharacterPresentationCatalog` maps an Agent ID to portrait, role title, accent color, world
  idle sprite, and motion frames only. It cannot discover, authorize, load, or reject an Agent;
  unknown IDs resolve to a visual fallback.
- `CharacterInfoPanel` receives immutable Agent/Session snapshots, renders real fields, owns its
  tabs and drag boundary, and never calls the Client or Controller.
- `PartnerActor` emits a spatial inspection intent. `WorkshopWorld` forwards it; neither opens UI.
- The [character-information contract](../character-info-ux.md) owns the scoped visual baseline,
  interactions, and asset rules. A full Art Bible remains a later production gate.

## Consequences

- Menu, task, and character information cannot overlap or acquire different input-lock rules.
- Agent availability remains solely owned by Host/Service/Controller data.
- The game can decorate future Agents safely through fallback without adding a game-side allowlist.
- The visual mapping is intentionally concrete and is not a theme framework or backend abstraction.
- Status values are read-only projections of Controller state; no new Run or Session state exists.
- `PartnerActor` owns movement state; `PartnerAnimator` consumes it to select animation. Sprite frames
  never influence velocity, collision, ladder limits, or Session behavior.

## Verification

`CharacterInfoHarness` covers the three open paths, P/Esc/close behavior, overlay mutual exclusion,
fallback presentation, status priority, viewport clamping, and Session/actor preservation over the
real WebSocket Protocol v2 test transport.
