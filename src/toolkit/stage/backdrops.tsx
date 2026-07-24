import { useTexture } from "@react-three/drei";
import { useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  LinearFilter,
  MeshBasicMaterial,
  RGBAFormat,
  ShadowMaterial,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
} from "three";
import { resolveAssetUrl } from "../../engine/project";
import { ProjectIdContext } from "../../engine/sceneContext";
import { useEditorStore } from "../../store/editorStore";
import { useTheme } from "../../theme";
import { hexToOklch, mixOklch, type Oklch, oklchToBytes } from "../../theme/oklch";
import type { GradientSpec, ThemeBackdrop, ThemeShadowSpec } from "../../theme/tokens";
import { AssetBoundary } from "../media/AssetBoundary";

/** Staging backdrops, mounted by `<SceneStage>` from the scene's resolved backdrop spec: all three surface kinds render UNLIT with `toneMapped: false` so theme hexes/gradients/images land EXACTLY (a `#ffffff` background through ACES would render grey, the device-screen precedent), and receive real shadows through a `ShadowMaterial` catcher overlay drawn just in front (polygon offset); geometry/texture constants below are EXPORT CONTRACT. See docs/determinism.md ("Staging"). */

// ── Stage geometry constants (export contract) ────────────────────────────────
/** Cyclorama width along x; generous so every aspect/camera orbit stays covered. */
const CYC_WIDTH = 40;
/** Floor extends from here (toward/past the camera at z≈5)... */
const CYC_FRONT_Z = 9;
/** ...to the wall plane. */
const CYC_WALL_Z = -6;
const CYC_WALL_HEIGHT = 14;
const CYC_ARC_SEGMENTS = 24;
const DEFAULT_FILLET = 2.5;
/** Vertical backdrops (gradient/image): a generous plane behind the content. */
const BACKDROP_WIDTH = 44;
const BACKDROP_HEIGHT = 22;
const BACKDROP_Z = -6;
/** Gradient texture resolution (pure-JS DataTexture, deterministic everywhere). */
const GRADIENT_SIZE = 512;

/** Cyclorama profile swept along x: flat floor → quarter-circle fillet → vertical back wall, so the floor/wall junction never shows a horizon seam; built at y=0 floor level, position the mesh to set the stage floor height. */
function cycGeometry(fillet: number): BufferGeometry {
  // Profile points in (z, y) with their (nz, ny) normals (analytic; the catcher's shadow sampling wants real normals even though the base material is unlit).
  const profile: [number, number, number, number][] = [];
  const arcCenterZ = CYC_WALL_Z + fillet;
  profile.push([CYC_FRONT_Z, 0, 0, 1]);
  for (let i = 0; i <= CYC_ARC_SEGMENTS; i++) {
    const phi = (i / CYC_ARC_SEGMENTS) * (Math.PI / 2);
    const z = arcCenterZ - fillet * Math.sin(phi);
    const y = fillet - fillet * Math.cos(phi);
    profile.push([z, y, Math.sin(phi), Math.cos(phi)]);
  }
  profile.push([CYC_WALL_Z, CYC_WALL_HEIGHT, 1, 0]);

  const rows = profile.length;
  const positions = new Float32Array(rows * 2 * 3);
  const normals = new Float32Array(rows * 2 * 3);
  const uvs = new Float32Array(rows * 2 * 2);
  for (let r = 0; r < rows; r++) {
    const [z, y, nz, ny] = profile[r];
    for (let c = 0; c < 2; c++) {
      const i = r * 2 + c;
      positions.set([c === 0 ? -CYC_WIDTH / 2 : CYC_WIDTH / 2, y, z], i * 3);
      normals.set([0, ny, nz], i * 3);
      uvs.set([c, r / (rows - 1)], i * 2);
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    const a = r * 2;
    const b = r * 2 + 1;
    const c = (r + 1) * 2;
    const d = (r + 1) * 2 + 1;
    indices.push(a, b, c, b, d, c);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

/** #rrggbb → raw sRGB bytes (NOT three's Color, that converts to linear working space). */
function hexBytes(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const v = Number.parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Radial gradients run centre → corner: t = 1 exactly at the square's corners. */
const RADIAL_EXTENT = Math.SQRT1_2;

/** A gradient rasterised in pure JS (bit-identical on any machine) into an sRGB DataTexture: linear follows the CSS angle convention (0° = to top, 90° = to right) normalised so 0/1 land on the square's corners along the gradient axis, radial runs centre to corners; stops interpolate per-channel in sRGB bytes (the v8 CSS look, byte-frozen by the standing baselines) unless `space: "oklch"`, which interpolates perceptually through `theme/oklch.ts` (export contract). Exported for the fixed background (same raster, stretched to the frame). */
export function gradientTexture(spec: GradientSpec): DataTexture {
  const oklch = spec.space === "oklch";
  const stops = [...spec.stops]
    .sort((a, b) => a[1] - b[1])
    .map(([hex, pos]) => ({
      rgb: hexBytes(hex),
      lch: oklch ? hexToOklch(hex) : (null as Oklch | null),
      pos,
    }));
  const a = (spec.angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = Math.cos(a);
  const extent = 0.5 * (Math.abs(dx) + Math.abs(dy)) || 1;
  const radial = spec.type === "radial";
  const size = GRADIENT_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let yPix = 0; yPix < size; yPix++) {
    const v = yPix / (size - 1); // v=0 at the texture's bottom row (three UV convention)
    for (let xPix = 0; xPix < size; xPix++) {
      const u = xPix / (size - 1);
      const t = radial
        ? Math.min(1, Math.hypot(u - 0.5, v - 0.5) / RADIAL_EXTENT)
        : Math.min(1, Math.max(0, (((u - 0.5) * dx + (v - 0.5) * dy) / extent) * 0.5 + 0.5));
      let lo = stops[0];
      let hi = stops[stops.length - 1];
      for (let s = 0; s < stops.length - 1; s++) {
        if (t >= stops[s].pos && t <= stops[s + 1].pos) {
          lo = stops[s];
          hi = stops[s + 1];
          break;
        }
      }
      const span = hi.pos - lo.pos;
      const k = span > 0 ? Math.min(1, Math.max(0, (t - lo.pos) / span)) : 0;
      const i = (yPix * size + xPix) * 4;
      if (lo.lch && hi.lch) {
        const [r, g, b] = oklchToBytes(mixOklch(lo.lch, hi.lch, k));
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
      } else {
        // The v8 per-channel sRGB path: arithmetic byte-frozen, never touch.
        data[i] = Math.round(lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * k);
        data[i + 1] = Math.round(lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * k);
        data[i + 2] = Math.round(lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * k);
      }
      data[i + 3] = 255;
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** An unlit, exact-colour material (the screen-material precedent); exported for the fixed background, which shares the exact-colour discipline. */
export function useExactMaterial(configure: (m: MeshBasicMaterial) => void, deps: unknown[]) {
  const material = useMemo(() => {
    const m = new MeshBasicMaterial({ side: DoubleSide });
    m.toneMapped = false;
    configure(m);
    return m;
    // biome-ignore lint/correctness/useExhaustiveDependencies: caller-supplied dep list
  }, deps);
  useLayoutEffect(() => () => material.dispose(), [material]);
  return material;
}

/** The shadow catcher: same geometry, drawn just in front, darkening by shadow tokens. */
function Catcher({
  geometry,
  shadow,
  position,
}: {
  geometry: BufferGeometry;
  shadow: ThemeShadowSpec;
  position?: [number, number, number];
}) {
  const material = useMemo(() => {
    const m = new ShadowMaterial({ opacity: shadow.opacity });
    m.color = new Color(shadow.color ?? "#000000");
    m.depthWrite = false;
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    m.polygonOffsetUnits = -1;
    m.side = DoubleSide;
    return m;
  }, [shadow.opacity, shadow.color]);
  useLayoutEffect(() => () => material.dispose(), [material]);
  return <mesh geometry={geometry} material={material} position={position} receiveShadow />;
}

interface BackdropProps {
  spec: ThemeBackdrop;
  /** Present only when the stage renders map shadows; mounts the catcher overlays. */
  shadow?: ThemeShadowSpec;
  /** Stage floor height (world y) for the cyclorama. */
  floorY?: number;
}

function CycFloor({
  spec,
  shadow,
  floorY = -1.5,
}: BackdropProps & { spec: Extract<ThemeBackdrop, { type: "floor" }> }) {
  const geometry = useMemo(
    () => cycGeometry(spec.filletRadius ?? DEFAULT_FILLET),
    [spec.filletRadius],
  );
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  const material = useExactMaterial((m) => m.color.set(spec.color), [spec.color]);
  return (
    <>
      <mesh geometry={geometry} material={material} position={[0, floorY, 0]} />
      {shadow && <Catcher geometry={geometry} shadow={shadow} position={[0, floorY, 0]} />}
    </>
  );
}

function GradientPlane({
  spec,
  shadow,
}: BackdropProps & { spec: Extract<ThemeBackdrop, { type: "gradient" }> }) {
  const theme = useTheme();
  // An inline spec wins over the theme lookup (the ThemeBackground rule).
  const gradient = spec.spec ?? (spec.gradient ? theme.gradients?.[spec.gradient] : undefined);
  const texture = useMemo(() => (gradient ? gradientTexture(gradient) : null), [gradient]);
  useLayoutEffect(() => () => texture?.dispose(), [texture]);
  const material = useExactMaterial(
    (m) => {
      m.map = texture;
    },
    [texture],
  );
  const geometry = useMemo(() => cycPlaneGeometry(), []);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  if (!gradient) {
    console.warn(`[stage] gradient "${spec.gradient}" not found in the theme — no backdrop`);
    return null;
  }
  return (
    <>
      <mesh geometry={geometry} material={material} position={[0, 4, BACKDROP_Z]} />
      {shadow && <Catcher geometry={geometry} shadow={shadow} position={[0, 4, BACKDROP_Z]} />}
    </>
  );
}

/** Shared plane geometry for the vertical backdrops (plane geometry, but built once). */
function cycPlaneGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  const w = BACKDROP_WIDTH / 2;
  const h = BACKDROP_HEIGHT / 2;
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([-w, -h, 0, w, -h, 0, -w, h, 0, w, h, 0]), 3),
  );
  geometry.setAttribute(
    "normal",
    new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
  );
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
  geometry.setIndex([0, 1, 2, 1, 3, 2]);
  return geometry;
}

// Bundled backdrop images (the Loft studio asset): `kookaburra:<name>` sources resolve to committed files under src/assets/backdrops/ so a BUILT-IN theme can ship an image backdrop; anything else stays project-relative (user themes and scene-doc overrides reference project assets).
const bundledBackdropGlob = import.meta.glob<string>("../../assets/backdrops/*.{jpg,png}", {
  query: "?url",
  import: "default",
  eager: true,
});

export function bundledBackdropUrl(name: string): string | null {
  return (
    bundledBackdropGlob[`../../assets/backdrops/${name}.jpg`] ??
    bundledBackdropGlob[`../../assets/backdrops/${name}.png`] ??
    null
  );
}

/** Loaded bundled-backdrop textures, keyed by URL; read SYNCHRONOUSLY at render. */
const bundledTextures = new Map<string, Texture>();
let bundledLoad: Promise<void> | null = null;

/** Loads every bundled backdrop image into the module cache, awaited by the export preamble and theme-preview capture paths, fired at boot: bundled backdrops must NEVER load through suspense since a mid-session theme switch suspending on one keeps the previous committed tree on screen (the scene-host barrier can't see an update-suspension) and a borrowed-clock capture then reads the stale frame (the loft-1 preview bug, 2026-07-07); the cache is tiny and read synchronously by `ImagePlaneBundled`. */
export function preloadBundledBackdrops(): Promise<void> {
  bundledLoad ??= Promise.all(
    Object.values(bundledBackdropGlob).map(async (url) => {
      const texture = await new TextureLoader().loadAsync(url);
      texture.colorSpace = SRGBColorSpace;
      bundledTextures.set(url, texture);
    }),
  ).then(() => undefined);
  return bundledLoad;
}

/** Sync accessor for the awaited bundled-backdrop cache (the fixed background shares it: same preload barrier, same never-suspend rule). */
export function getBundledBackdropTexture(url: string): Texture | null {
  return bundledTextures.get(url) ?? null;
}

function ImagePlane({
  spec,
  shadow,
}: BackdropProps & { spec: Extract<ThemeBackdrop, { type: "image" }> }) {
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((s) => s.projectId);
  const projectId = contextProjectId ?? storeProjectId;
  // Missing assets degrade to no backdrop, never tear down the canvas tree (the bootTrap lesson); the suspense load is covered by the scene-host commit barrier (`awaitSceneHostsCommitted`), same as every other cold-mount texture.
  if (spec.src.startsWith("kookaburra:")) {
    const bundled = bundledBackdropUrl(spec.src.slice("kookaburra:".length));
    if (!bundled) {
      console.warn(`[stage] bundled backdrop "${spec.src}" not found — no backdrop`);
      return null;
    }
    return <ImagePlaneBundled url={bundled} spec={spec} shadow={shadow} />;
  }
  let url: string | null = null;
  try {
    url = resolveAssetUrl(projectId, spec.src);
  } catch (e) {
    console.warn(`[stage] image backdrop "${spec.src}" unresolved:`, e);
  }
  if (!url) return null;
  return (
    <AssetBoundary key={url} label={spec.src}>
      <ImagePlaneLoaded url={url} spec={spec} shadow={shadow} />
    </AssetBoundary>
  );
}

/** The shared image-plane render: cover-fit + unlit material + catcher (both sources). */
function ImagePlaneMesh({
  texture,
  spec,
  shadow,
}: {
  texture: Texture;
  spec: Extract<ThemeBackdrop, { type: "image" }>;
  shadow?: ThemeShadowSpec;
}) {
  useLayoutEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    // Cover-fit: crop via repeat/offset so the image fills the plane without stretching.
    const img = texture.image as { width: number; height: number } | undefined;
    if (img && spec.fit !== "contain") {
      const planeAspect = BACKDROP_WIDTH / BACKDROP_HEIGHT;
      const imageAspect = img.width / img.height;
      if (imageAspect > planeAspect) {
        texture.repeat.set(planeAspect / imageAspect, 1);
        texture.offset.set((1 - texture.repeat.x) / 2, 0);
      } else {
        texture.repeat.set(1, imageAspect / planeAspect);
        texture.offset.set(0, (1 - texture.repeat.y) / 2);
      }
    }
    texture.needsUpdate = true;
  }, [texture, spec.fit]);
  const material = useExactMaterial(
    (m) => {
      m.map = texture;
    },
    [texture],
  );
  const geometry = useMemo(() => cycPlaneGeometry(), []);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <>
      <mesh geometry={geometry} material={material} position={[0, 4, BACKDROP_Z]} />
      {shadow && <Catcher geometry={geometry} shadow={shadow} position={[0, 4, BACKDROP_Z]} />}
    </>
  );
}

/** Project-relative (user) image backdrops keep the suspense load; covered at export by the scene-host barrier, and never switched mid-capture (a scene-doc edit reloads the project). */
function ImagePlaneLoaded({
  url,
  spec,
  shadow,
}: {
  url: string;
  spec: Extract<ThemeBackdrop, { type: "image" }>;
  shadow?: ThemeShadowSpec;
}) {
  const texture = useTexture(url) as Texture;
  return <ImagePlaneMesh texture={texture} spec={spec} shadow={shadow} />;
}

/** Bundled (`kookaburra:`) image backdrops read the awaited module cache, NO suspense (see preloadBundledBackdrops); a not-yet-loaded texture renders no backdrop for a frame and self-heals on load, unreachable during capture/export. */
function ImagePlaneBundled({
  url,
  spec,
  shadow,
}: {
  url: string;
  spec: Extract<ThemeBackdrop, { type: "image" }>;
  shadow?: ThemeShadowSpec;
}) {
  const [, bump] = useState(0);
  const texture = bundledTextures.get(url) ?? null;
  useEffect(() => {
    if (!texture) void preloadBundledBackdrops().then(() => bump((n) => n + 1));
  }, [texture]);
  if (!texture) return null;
  return <ImagePlaneMesh texture={texture} spec={spec} shadow={shadow} />;
}

/** The stage's backdrop, switched on the resolved spec. `none` renders nothing. */
export function StageBackdrop({ spec, shadow, floorY }: BackdropProps) {
  switch (spec.type) {
    case "floor":
      return <CycFloor spec={spec} shadow={shadow} floorY={floorY} />;
    case "gradient":
      return <GradientPlane spec={spec} shadow={shadow} />;
    case "image":
      return <ImagePlane spec={spec} shadow={shadow} />;
    default:
      return null;
  }
}
