# Character Information: UX and Art Contract

## Scope and frozen baseline

The user approved the current dossier on 2026-09-06. Preserve its 750 × 690 layout, thin
wood/parchment frame, bundled typography, original character inspection animation, and
Profile/Status/detail navigation. Change it only for a demonstrated defect or approved design revision.
The baseline passed graphical and automated checks on macOS; this is not cross-platform or
exported-build certification.

This read-only window presents the currently open Agent Session. It does not create Agents,
fabricate history, or implement Build. Its art rules cover this slice only; a complete Game Concept
and Art Bible remain prerequisites for broader art production. Conversation behavior belongs to
[the conversation contract](agent-conversation-ux.md), and ownership rationale to
[ADR-0004](adr/0004-godot-character-information.md).

## Layout and interaction

The logical viewport is 1440 × 900. The default panel starts at `(70, 90)` with a 16 px safe edge.
The header is draggable outside its buttons; entry uses a 120 ms fade and 12 px horizontal slide.
The left side shows the live character, and the right side contains Profile/Status. Build remains
disabled. Panel-local landmarks are frozen:

| Element                 |   X |   Y | Width | Height |
| ----------------------- | --: | --: | ----: | -----: |
| Framed portrait         |  34 |  34 |    96 |     98 |
| Tabs                    | 256 | 117 |   465 |     44 |
| Character stage         |  31 | 174 |   328 |    368 |
| Overlapping name plaque | 114 | 514 |   156 |     47 |
| Introduction card       | 373 | 180 |   350 |    164 |
| Status card             | 373 | 356 |   350 |    178 |
| Build reservation       | 373 | 572 |   350 |     36 |
| Centered footer         |  24 | 636 |   702 |     38 |

Profile uses the real Agent name, description, package name, and version. Status projects Ready,
Preparing, Working, or Cancelling and the current Session ID; icons never replace status text.
Technical details are hidden initially. Their toggle replaces the fixed status summary with a
scrolling details body and a visible return control. Long descriptions scroll independently.
Neither disclosure nor wrapping may resize the window or move the character stage.

| Input                  | Result                                             |
| ---------------------- | -------------------------------------------------- |
| Click partner/portrait | Open character information                         |
| `P`                    | Toggle character information                       |
| `Esc`                  | Close the active overlay                           |
| Drag title bar         | Move and clamp the window inside the safe viewport |

Outside clicks do not close the panel. Opening locks world input without pausing the scene tree;
closing preserves the Session, physical position, and camera. `GameRoot` owns the single
`NONE | MENU | TASK | CHARACTER_INFO | PERMISSION` state. Busy/running state prevents opening INFO;
permissions temporarily replace the current overlay and restore it after settlement.

## Visual direction

Keep the workshop visible behind a flat light-wood and warm-parchment window. Preserve the mages'
deep-brown silhouettes, warm hand-painted shading, and approved proportions. Avoid ornate carving,
dark fantasy framing, baked text, perspective UI, and full-screen dimming.

| Role               | Color       |
| ------------------ | ----------- |
| Warm parchment     | `#F3E6C8`   |
| Light wood         | `#A86F3E`   |
| Deep-brown outline | `#4A3026`   |
| Forest green       | `#3F6B4F`   |
| Sky teal           | `#6BA9A7`   |
| Coding accent      | Warm orange |
| Analysis accent    | Muted rose  |

[Early mockups](https://github.com/xdnloveme/omni-agent/tree/4df2b22b3aa5da75363dd11a9b7294836c8a8339/docs/images/info-v1)
remain historical inspiration, not production textures or acceptance screenshots. Current character
identities, anchors, and motion resources are defined by the
[production character contract](godot-workshop-environment.md#production-characters-and-art) and
[v76 production notes](godot-workshop-environment.md#rose-mage-v76), not duplicated here.
Unknown Agents reuse the Coding mage art while retaining their Host-provided name and generic role.

## Assets and rendering

All dossier PNGs are under `apps/omni-game/assets/ui/character-info/`. Text, tabs, status, and
interaction remain live Godot controls; do not bake localization or Agent/Session values into art.

| Asset                  | Role and import limit                        |
| ---------------------- | -------------------------------------------- |
| `dossier-frame.png`    | Nine-slice thin wood/ivory frame; 1024 px    |
| `character-alcove.png` | Empty niche/plinth behind the live character |
| `name-plaque.png`      | Blank nameplate; 512 px                      |
| `profile-book.png`     | Introduction icon; 128 px                    |
| `status-sprout.png`    | State heading icon; 128 px                   |
| `close-tile.png`       | Blank close-button tile; 128 px              |
| `status-ready.png`     | Ready-state icon, authored 48 × 48           |
| `status-working.png`   | Working/cancelling icon, authored 48 × 48    |

Use sRGB RGBA PNG, linear sampling, and no UI mipmaps. Portrait edges must remain clean at 48 px.
Portraits come from `CharacterPresentation`; Coding and the generic presentation share
`coding-portrait.tres`. There is no separate fallback artwork.

`CharacterPreview` reuses `CharacterAnimationSet.frames`, `inspection_animation`, and the declared
foot anchor with uniform scaling. It plays the authored idle only while visible. The alcove has no
baked character: its 76% plinth baseline is overscanned to meet the character at 50% width / 82%
visible-stage height. It does not replace world animation or influence physics.

[CharacterInfoPanel.tscn](../apps/omni-game/scenes/CharacterInfoPanel.tscn) owns the frame's 64 px
source margins and rounded-padding clip shader (18 px source radius at 1413 px width).
The frame uses `StyleBoxTexture`; content and control states use the Godot theme and `StyleBoxFlat`.

Typography uses bundled [Noto Sans SC](https://github.com/google/fonts/tree/main/ofl/notosanssc)
(`assets/fonts/NotoSansSC.ttf`) with the adjacent OFL license. Headings use
native weight 700 and body text weight 500; serialize the OpenType `wght` tag as `2003265652`.
There is no system-font dependency or synthetic bold. The approved theme defaults to 20 px;
the frozen scene explicitly uses 18 px technical fields and a 16 px help footer. Preserve its
individual control dimensions rather than imposing a contradictory global minimum.

## Acceptance

`CharacterInfoHarness` through `pnpm run verify:game` checks the three open paths, overlay exclusion,
status priority, fallback identity, drag bounds, preview playback, and Session/actor preservation.
Inspect the actual Main panel for visual acceptance. Keep unique character art, live controls,
readable labels, unclipped details/return controls, and the frozen stage geometry. Historical image
prompts and screenshot experiments remain in Git history rather than a second maintained spec.
