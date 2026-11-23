# Workshop Upper Foreground Asset Spec

> Status: approved implementation contract
>
> Production builder: `scripts/build-workshop-native-foreground.py`
>
> Offline inputs: `scripts/workshop-layer-sources/README.md`

## Source-of-truth contract

The approved backplate and native rail/bridge modules are registered on one 2400 × 960 canvas.
The production builder reads the canonical runtime backplate for palette matching and exports only
the rails, bridge deck, and rope decoration. It performs deterministic offline chroma-keying and
placement; it neither copies nor overwrites the approved backplate.
Runtime rendering never reads or analyses pixels; it displays the exported PNG layers directly.

The runtime stack has one clean backplate, one true-alpha rail layer, one independent bridge deck,
and one background rope decoration layer. Rails and bridge are in front of the actor; hand ropes
and ceiling hangers are behind it. The bed opening is an explicit transparent gap. The rail layer does
not contain rectangular scenery plates, duplicated floors, or gameplay geometry.

`scripts/build-workshop-native-foreground.py` is the only maintained upper-foreground export path.
Source-only images stay outside the Godot project. Test screenshots are ignored build artifacts.

## Visual acceptance

- Rebuilding with the documented dependencies preserves the approved production PNGs.
- The bed opening at `x=442..569` remains fully transparent.
- The upper-ladder exit corridor at `x=960..991` contains no opaque left-rail post; the left-inner
  rail terminates at `x=960`, leaving the `x=1016` ladder center visually traversable.
- Horizontal rails remain continuous in each authored span; single-rail openings are intentional.
- Every associated post is a continuous silhouette grounded on the visible platform.
- Rail gaps are transparent; no sky, wall rectangle, or unrelated shelf pixel may cover the actor.
- Organic foliage may cross a rail only where it is part of the authored silhouette; hard rectangular
  foliage edges and isolated leaf-difference fragments are forbidden.
- The bridge contact surface follows the asymmetric painted plank tops from `y=289` through the
  `y=300` center sag to `y=286` over `x=1088..1244`.
- Both bridge joins touch their platform terminals without a seam or floating endpoint.
- The curved bridge hand ropes are independent background decoration behind the actor. The two ceiling hangers
  continue to the bridge deck; only the wooden contact lip remains in the foreground layer.
- The bridge foreground covers only the shoe contact edge, not the actor's ankle or body.
- `TraversalOcclusionHarness` checks registered layers and alpha boundaries;
  `WorkshopWorldHarness` checks live movement, bridge contact and ladder behavior.

## Asset contract

All paths below are under `res://assets/environment/workshop/`.

| Layer       | Asset                             | Native size | World mapping           | Z   |
| ----------- | --------------------------------- | ----------- | ----------------------- | --- |
| Backplate   | `workshop-backplate-stylized.png` | 1983 × 793  | 2400 × 960 at origin    | -20 |
| Decoration  | `workshop-bridge-decoration.png`  | 2400 × 960  | 1:1 at origin           | -18 |
| Rails       | `workshop-rails-stylized.png`     | 2400 × 960  | 1:1 at origin           | 5   |
| Bridge deck | `workshop-bridge-stylized.png`    | 640 × 172   | 160 × 43 at (1087, 278) | 5   |

All layers are lossless PNG with linear filtering, disabled mipmaps and no collision.
Rails, deck and decoration use true alpha. Rails must contain no duplicate bridge pixels.
The backplate is not a 4K source; large screenshots do not add source detail.

Run `pnpm verify:game --visual` to verify the normal Main scene, route contracts and fullscreen.

The companion outer-edge foliage remains
`res://assets/environment/workshop/workshop-edge-foliage-foreground.png`. It is independent from
the upper guardrail layer and its playable-band contour must remain organic.
