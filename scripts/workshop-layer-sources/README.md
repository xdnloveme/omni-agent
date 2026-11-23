# Workshop production artwork sources

These are offline build inputs, not Godot runtime assets. The current runtime PNGs live in
`apps/omni-game/assets/`; do not move source references or experimental variants back there.

From the repository root, with Python 3, Pillow 11.3.0 and NumPy 2.0.2 available:

```sh
python3 scripts/build-workshop-native-foreground.py
```

The builder produces true-alpha rails, the bridge deck, and background rope decoration.
It reads the approved runtime backplate as its canonical palette reference without rewriting it. The 1983 × 793
backplate keeps its native pixels and maps to the
2400 × 960 world; the 640 × 172 bridge maps to 160 × 43 world units. Rails and decoration use
the 2400 × 960 canvas. No runtime pixel processing or preview override is involved.
It writes only the three derived production layers; the former composite-preview export has been removed.

The six offline inputs in this directory:

- `workshop-stylized-bridge-chroma-v1.png`: approved refined bridge source.
- `workshop-palette-and-rope-reference.png`: preserved decorative rope reference;
  this is not an alternate runtime foreground.
- `workshop-native-rail-left-outer-chroma-v1.png`,
  `workshop-native-rail-left-inner-chroma-v1.png`, and
  `workshop-native-rail-right-chroma-v6.png`: approved continuous rail spans.
- `workshop-native-hanger-extension-chroma-v1.png`: painted ceiling-rope extension.

The former `workshop-stylized-backplate-v1.png` source copy was pixel-identical to the
runtime `workshop-backplate-stylized-v1.png`. Only the runtime master is retained.

Historical geometry references `workshop-clean-backplate-base.png` and
`workshop-native-bridge-v1.png` were removed after confirming the builder does not read them.
They remain recoverable from commit `2da60f5d`. The current palette reference comes from the
approved stylized backplate itself.

The remaining runtime textures (edge foliage, sky mask, clouds, ladders, character atlases,
portraits and UI icons) are approved standalone assets, not outputs of this builder.
The obsolete semantic-difference and layered-V6 export pipelines are no longer maintained.

Run `pnpm verify:game --visual` after rebuilding; it imports Godot textures before running the
harnesses and captures the actual Main scene through its normal character-selection flow,
using a deterministic Host fixture. It also checks traversal and native fullscreen rendering.
Use the actual Main scene for visual inspection. `TraversalOcclusionHarness` checks registered
layers and alpha boundaries; `WorkshopWorldHarness` checks the real route and physics.
Generated screenshots are excluded from version control and Godot import.
