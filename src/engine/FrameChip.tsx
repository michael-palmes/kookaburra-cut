import { Text } from "@react-three/drei";
import { useEffect, useMemo, useState } from "react";
import { Color, MeshBasicMaterial, SRGBColorSpace, Vector2 } from "three";
import { useTheme } from "../theme";
import { fontUrl } from "../theme/fonts";
import type { Theme } from "../theme/tokens";
import type { FrameChipSpec } from "../toolkit/frame/types";
import type { V3 } from "../toolkit/types";
import { FrameIcon } from "./FrameIcon";
import { useHeldLocalMs } from "./presentHold";
import { useTimeline } from "./timeline";

const COLOUR_TOKENS = ["background", "text", "accent", "muted"] as const;
type ColourToken = (typeof COLOUR_TOKENS)[number];

/** Chip fill: a theme token, a hex, or the accent default. */
function resolveChipColour(theme: Theme, colour: string | undefined): string {
  if (colour === undefined) return theme.colors.accent;
  if (COLOUR_TOKENS.includes(colour as ColourToken)) return theme.colors[colour as ColourToken];
  return colour;
}

const _c = new Color();
const _srgb = { r: 0, g: 0, b: 0 };

/** A light or dark label token that reads on the given pill fill, by its sRGB luminance. */
function contrastToken(theme: Theme, fill: string): string {
  _c.set(fill).getRGB(_srgb, SRGBColorSpace);
  const lum = 0.2126 * _srgb.r + 0.7152 * _srgb.g + 0.0722 * _srgb.b;
  return lum > 0.55 ? theme.colors.background : theme.colors.text;
}

/** The capsule SDF, injected into a `MeshBasicMaterial` (the `ImageCard` shine precedent) so the pill inherits three's colour pipeline and we supply only the rounded alpha; a pure function of the local vertex position (no derivatives), so AA is compile-stable like the cutout shader. */
function makePillMaterial(): {
  material: MeshBasicMaterial;
  half: { value: Vector2 };
  radius: { value: number };
  feather: { value: number };
} {
  const half = { value: new Vector2(1, 1) };
  const radius = { value: 1 };
  const feather = { value: 0.01 };
  const material = new MeshBasicMaterial({ transparent: true, depthWrite: false });
  material.toneMapped = false;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHalf = half;
    shader.uniforms.uRadius = radius;
    shader.uniforms.uFeather = feather;
    shader.vertexShader = `varying vec2 vPillP;\n${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n  vPillP = position.xy;",
    );
    shader.fragmentShader =
      `varying vec2 vPillP;\nuniform vec2 uHalf;\nuniform float uRadius;\nuniform float uFeather;\n${shader.fragmentShader}`.replace(
        "#include <opaque_fragment>",
        `#include <opaque_fragment>
        vec2 q = abs(vPillP) - uHalf + uRadius;
        float pillD = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
        gl_FragColor.a *= 1.0 - smoothstep(-uFeather, uFeather, pillD);`,
      );
  };
  material.customProgramCacheKey = () => "kookaburra-frame-chip-v1";
  return { material, half, radius, feather };
}

type Bounds = readonly [number, number, number, number];

/** A status pill for the overlay panel: a rounded capsule fill (theme token or hex), a contrast label and an optional inline mark (a "✓" glyph, an emoji or an image). Sized to the measured label so the capsule always hugs its text; the whole chip is a timeline fade, so it settles well after the label measures and stays deterministic. `position` is the pill's bottom-left, world (y-up). See docs/overlays.md. */
export function FrameChip({
  chip,
  position,
  height,
  from,
  to,
}: {
  chip: FrameChipSpec;
  position: V3;
  /** Pill height, world units. */
  height: number;
  from: number;
  to: number;
}) {
  const theme = useTheme();
  const { localMs: rawLocalMs } = useTimeline();
  const localMs = useHeldLocalMs(rawLocalMs);
  const [bounds, setBounds] = useState<Bounds | null>(null);

  const pill = useMemo(() => makePillMaterial(), []);
  useEffect(() => () => pill.material.dispose(), [pill]);

  const fill = resolveChipColour(theme, chip.colour);
  const labelColour = contrastToken(theme, fill);
  const fade = to <= from ? 1 : Math.min(1, Math.max(0, (localMs - from) / (to - from)));

  const padX = height * 0.5;
  const labelSize = height * 0.42;
  const markSize = height * 0.52;
  const markGap = height * 0.26;
  const markAdvance = chip.icon ? markSize + markGap : 0;
  const centreY = position[1] + height / 2;
  const labelLeft = position[0] + padX + markAdvance;
  const labelWidth = bounds ? bounds[2] - bounds[0] : 0;
  const pillWidth = padX + markAdvance + labelWidth + padX;

  pill.material.color.set(fill);
  pill.material.opacity = fade;
  pill.half.value.set(pillWidth / 2, height / 2);
  pill.radius.value = height / 2;
  pill.feather.value = height * 0.045;

  return (
    <>
      {bounds && (
        <mesh
          material={pill.material}
          position={[position[0] + pillWidth / 2, centreY, position[2]]}
          renderOrder={0}
        >
          <planeGeometry args={[pillWidth, height]} />
        </mesh>
      )}
      <Text
        font={fontUrl(theme.typography.body)}
        position={[labelLeft, centreY, position[2] + 0.01]}
        fontSize={labelSize}
        color={labelColour}
        anchorX="left"
        anchorY="middle"
        fillOpacity={fade}
        renderOrder={1}
        onSync={(troika: { textRenderInfo?: { blockBounds?: number[] } }) => {
          const b = troika.textRenderInfo?.blockBounds;
          if (b && b.length === 4) setBounds([b[0], b[1], b[2], b[3]]);
        }}
      >
        {chip.label}
      </Text>
      {chip.icon && (
        <FrameIcon
          icon={chip.icon}
          position={[position[0] + padX, centreY + markSize / 2, position[2] + 0.01]}
          size={markSize}
          from={from}
          to={to}
          color={labelColour}
        />
      )}
    </>
  );
}
