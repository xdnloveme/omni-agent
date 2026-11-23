#!/usr/bin/env python3
"""Build the approved stylized Workshop layers from their authored sources."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "scripts/workshop-layer-sources"
ASSET_DIR = ROOT / "apps/omni-game/assets/environment/workshop"
BACKGROUND_SOURCE = ASSET_DIR / "workshop-backplate-stylized.png"
ROPE_REFERENCE = SOURCE_DIR / "workshop-palette-and-rope-reference.png"
NATIVE_BRIDGE = SOURCE_DIR / "workshop-stylized-bridge-chroma.png"
NATIVE_HANGER_EXTENSION = (
    SOURCE_DIR / "workshop-native-hanger-extension-chroma.png"
)
OUTPUT = ASSET_DIR / "workshop-rails-stylized.png"
BRIDGE_OUTPUT = ASSET_DIR / "workshop-bridge-stylized.png"
DECORATION_OUTPUT = ASSET_DIR / "workshop-bridge-decoration.png"
# Each module owns one continuous rail span. The bed opening and bridge gap are
# structural gaps, not transparent holes cut out of a larger sprite.
RAIL_MODULES = (
    (
        SOURCE_DIR / "workshop-native-rail-left-outer-chroma.png",
        (112, 216, 442, 300),
    ),
    (
        SOURCE_DIR / "workshop-native-rail-left-inner-chroma.png",
        (570, 214, 960, 300),
    ),
    (
        SOURCE_DIR / "workshop-native-rail-right-chroma.png",
        (1234, 214, 1774, 300),
    ),
)


def chroma_to_alpha(source: Image.Image) -> Image.Image:
    rgb = np.asarray(source.convert("RGB"), dtype=np.float32)
    red, green, blue = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    magenta = np.minimum(red, blue) - green
    balance = np.abs(red - blue)
    # Magenta spill remains magenta even when resampling makes red and blue
    # unequal. Key from chroma dominance alone so fringe pixels cannot become
    # opaque merely because one chroma channel is stronger than the other.
    alpha = np.clip((80.0 - magenta) / 45.0, 0.0, 1.0)
    alpha[alpha < 0.025] = 0.0
    alpha[alpha > 0.975] = 1.0

    candidates = (magenta > 170.0) & (balance < 24.0)
    background = np.median(rgb[candidates], axis=0)
    safe_alpha = np.maximum(alpha[..., None], 0.04)
    cleaned_rgb = (rgb - (1.0 - alpha[..., None]) * background) / safe_alpha
    cleaned_rgb[alpha == 0.0] = 0.0
    rgba = np.dstack((np.clip(cleaned_rgb, 0, 255), alpha * 255.0)).astype(np.uint8)
    return Image.fromarray(rgba)


def trim_alpha(image: Image.Image) -> Image.Image:
    alpha = np.asarray(image)[..., 3]
    ys, xs = np.nonzero(alpha >= 8)
    if xs.size == 0:
        raise RuntimeError("rail source has no visible pixels")
    return image.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))


def extract_rope_pixels(strokes: tuple[tuple[list[tuple[int, int]], int], ...]) -> Image.Image:
    source = Image.open(ROPE_REFERENCE).convert("RGBA")
    matte = Image.new("L", source.size, 0)
    draw = ImageDraw.Draw(matte)
    for points, width in strokes:
        draw.line(points, fill=255, width=width, joint="curve")
    matte = matte.filter(ImageFilter.GaussianBlur(0.6))

    rgba = np.asarray(source).copy()
    rgba[..., 3] = np.minimum(rgba[..., 3], np.asarray(matte))
    rgba[rgba[..., 3] == 0, :3] = 0
    return Image.fromarray(rgba)


def bridge_background_decoration() -> Image.Image:
    return extract_rope_pixels(
        (
            (
                [(994, 242), (1030, 251), (1070, 263), (1110, 270), (1150, 271), (1190, 263), (1240, 241)],
                10,
            ),
        )
    )


def connect_hangers_to_bridge(background: Image.Image) -> None:
    """Continue the authored ceiling hangers behind the actor to the bridge deck."""
    extension = trim_alpha(chroma_to_alpha(Image.open(NATIVE_HANGER_EXTENSION)))
    extension = extension.resize((7, 84), Image.Resampling.LANCZOS)
    background.alpha_composite(extension, (1157, 218))
    background.alpha_composite(
        extension.transpose(Image.Transpose.FLIP_LEFT_RIGHT),
        (1170, 218),
    )


def match_wood_palette(
    foreground: Image.Image,
    reference_image: Image.Image,
) -> Image.Image:
    candidate = np.asarray(foreground.convert("RGBA"), dtype=np.float32).copy()
    reference = np.asarray(reference_image.convert("RGBA"), dtype=np.float32)

    def samples(values: np.ndarray) -> np.ndarray:
        rgb, alpha = values[..., :3], values[..., 3]
        mask = (
            (alpha > 128)
            & (rgb[..., 0] > rgb[..., 1] + 5)
            & (rgb[..., 1] > rgb[..., 2] + 3)
            & (rgb[..., 0] > 25)
            & (rgb[..., 0] < 235)
        )
        return rgb[mask]

    source_samples = samples(candidate)
    reference_samples = samples(reference)
    source_q = np.quantile(source_samples, (0.25, 0.5, 0.75), axis=0)
    reference_q = np.quantile(reference_samples, (0.25, 0.5, 0.75), axis=0)
    scale = (reference_q[2] - reference_q[0]) / np.maximum(source_q[2] - source_q[0], 1.0)
    offset = reference_q[1] - source_q[1] * scale

    rgb = candidate[..., :3]
    corrected = rgb * scale + offset
    corrected[..., 2] = np.minimum(corrected[..., 2], corrected[..., 1] * 0.95 + 3.0)
    visible = candidate[..., 3] > 0
    candidate[visible, :3] = corrected[visible]
    candidate[candidate[..., 3] == 0, :3] = 0
    return Image.fromarray(np.clip(candidate, 0, 255).astype(np.uint8))


def build_rails() -> Image.Image:
    """Compose authored rail spans without the separately owned bridge deck."""
    foreground = Image.new("RGBA", (2400, 960), (0, 0, 0, 0))
    rail_modules: list[Image.Image] = []
    for path, target in RAIL_MODULES:
        module = trim_alpha(chroma_to_alpha(Image.open(path)))
        width, height = target[2] - target[0], target[3] - target[1]
        module = module.resize((width, height), Image.Resampling.LANCZOS)
        if rail_modules and path.name == "workshop-native-rail-right-chroma.png":
            module = match_wood_palette(module, rail_modules[1])
        foreground.alpha_composite(module, (target[0], target[1]))
        rail_modules.append(module)
    return foreground


def main() -> None:
    background = Image.open(BACKGROUND_SOURCE).convert("RGBA")
    if background.size != (1983, 793):
        raise RuntimeError("approved background dimensions changed; review scene registration")

    # Exact palette and scale used by the accepted whole-map candidate.
    timber = background.crop((92, 239, 904, 271))
    foreground = match_wood_palette(build_rails(), timber)
    bridge = trim_alpha(chroma_to_alpha(Image.open(NATIVE_BRIDGE)))
    bridge = bridge.resize((640, 172), Image.Resampling.LANCZOS)
    bridge = match_wood_palette(bridge, timber)
    decoration = bridge_background_decoration()
    connect_hangers_to_bridge(decoration)

    alpha = np.asarray(foreground)[..., 3]
    if np.count_nonzero(alpha[218:300, 442:569]):
        raise RuntimeError("bed opening contains foreground pixels")
    if np.count_nonzero(alpha[350:, :]):
        raise RuntimeError("foreground leaked below the upper-floor band")
    if np.count_nonzero(alpha[278:321, 1087:1234]):
        raise RuntimeError("rail layer contains a duplicate bridge")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    foreground.save(OUTPUT, optimize=True)
    bridge.save(BRIDGE_OUTPUT, optimize=True)
    decoration.save(DECORATION_OUTPUT, optimize=True)
    print(f"foreground={OUTPUT}")
    print(f"bridge={BRIDGE_OUTPUT}")
    print(f"decoration={DECORATION_OUTPUT}")
    print(f"active_pixels={int(np.count_nonzero(alpha >= 16))}")


if __name__ == "__main__":
    main()
