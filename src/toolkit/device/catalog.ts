import { useGLTF } from "@react-three/drei";
import type { Mesh, MeshStandardMaterial } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import previewBlack from "../../assets/device-previews/iphone-15-pro/black-titanium.png?url";
import previewBlue from "../../assets/device-previews/iphone-15-pro/blue-titanium.png?url";
import previewNatural from "../../assets/device-previews/iphone-15-pro/natural-titanium.png?url";
import previewWhite from "../../assets/device-previews/iphone-15-pro/white-titanium.png?url";
import preview17Orange from "../../assets/device-previews/iphone-17-pro/cosmic-orange.png?url";
import preview17Blue from "../../assets/device-previews/iphone-17-pro/deep-blue.png?url";
import preview17Silver from "../../assets/device-previews/iphone-17-pro/silver.png?url";
import previewMbpSilver from "../../assets/device-previews/macbook-pro-16/silver.png?url";
import previewMbpGrey from "../../assets/device-previews/macbook-pro-16/space-grey.png?url";
import { iphone17ProModelUrl, macbookPro16ModelUrl, phoneModelUrl } from "./modelUrl";

/** The device catalog: devices keyed by stable id + colour id, geometry bundled as fingerprinted glTFs so a model swap never touches a project; real product names are a deliberate 2026-07-05 trade-dress-risk decision (see docs/decisions.md), and iphone-15-pro's model derives from a LICENSED vendor .blend (see src/assets/models/README.md) whose colour overrides are exact linear-to-sRGB baseColorFactor replacements, not approximate tints. */

export type DeviceForm = "phone" | "laptop" | "tablet";

/** Named-material overrides a colour variant applies to the cloned model. */
export interface DeviceMaterialOverride {
  /** sRGB hex for `material.color` (the baseColorFactor slot); replaces the colour exactly when there's no baseColorTexture, else multiplies it. */
  color?: string;
}

export interface DeviceColourSpec {
  /** Stable id scenes reference, e.g. `"natural-titanium"`. */
  id: string;
  /** Display name for pickers, e.g. `"Natural Titanium"`. */
  name: string;
  /** Material-name → override. Empty = the model's authored (default) finish. */
  overrides: Record<string, DeviceMaterialOverride>;
  /** Picker swatch dot, the colour's frame value (display-only, never rendered 3D). */
  swatch: string;
}

/** How auto-fit normalises the model into the scene (Device.tsx's Box3 fit). */
export interface DeviceFitSpec {
  /** World-space extent the fit normalises; default "height" (the phone behaviour). */
  axis?: "height" | "width";
  /** World units the chosen axis fits to; default TARGET_WORLD_HEIGHT (2.6). */
  target?: number;
}

export interface DeviceSpec {
  /** Stable id scenes reference, e.g. `"iphone-15-pro"`. */
  id: DeviceId;
  /** Display name for pickers, e.g. `"iPhone 15 Pro"`. */
  name: string;
  form: DeviceForm;
  /** Bundled glb URL (`?url` import). */
  glbUrl: string;
  /** Display metadata: the screen mesh's material name + the display's width/height. */
  screen: { material: string; aspect: number };
  colours: DeviceColourSpec[];
  defaultColour: string;
  /** Colour id → bundled picker-card PNG (`pnpm assets:device-previews`). */
  previews: Record<string, string>;
  /** Auto-fit override; laptops fit by width since their bbox height is lid-angle-dependent. */
  fit?: DeviceFitSpec;
  /** Hinge for lid-angle control: the glb node (three.js-sanitised name) whose local X rotation opens the lid, the authored open angle, and the default pose when the doc sets none. */
  lid?: { node: string; openDeg: number; defaultDeg: number };
}

export type DeviceId = "iphone-15-pro" | "iphone-17-pro" | "macbook-pro-16";

/** The colour-varying material slots in the handset glb, per the vendor's four .blends: frame, two back-glass finishes, and antenna/inlay trim, eight materials, five distinct values. */
interface TitaniumFinish {
  /** TITANIUM Rough / Brushed / Polished + SCREWS. */
  frame: string;
  backRough: string;
  backPolished: string;
  antennas: string;
  inlay: string;
}

const FRAME_MATERIALS = ["TITANIUM Rough", "TITANIUM Brushed", "TITANIUM Polished", "SCREWS"];

/** The glb's authored (natural) frame factor, sRGB-encoded; the no-override swatch. */
const NATURAL_FRAME_SWATCH = "#b3ab98";

function titaniumColour(id: string, name: string, finish: TitaniumFinish | null): DeviceColourSpec {
  const overrides: Record<string, DeviceMaterialOverride> = {};
  if (finish) {
    for (const m of FRAME_MATERIALS) overrides[m] = { color: finish.frame };
    overrides["GL_BACK Rough"] = { color: finish.backRough };
    overrides["GL_BACK Polished"] = { color: finish.backPolished };
    overrides.PL_ANTENNAS = { color: finish.antennas };
    overrides.PL_INLAY = { color: finish.inlay };
  }
  return { id, name, overrides, swatch: finish?.frame ?? NATURAL_FRAME_SWATCH };
}

// Entry order is the picker order (DEVICE_IDS): 17 Pro leads as the default device.
export const DEVICE_CATALOG: Record<DeviceId, DeviceSpec> = {
  "iphone-17-pro": {
    id: "iphone-17-pro",
    name: "iPhone 17 Pro",
    form: "phone",
    glbUrl: iphone17ProModelUrl,
    // 2622 x 1206 display, portrait; matches the measured screen mesh (0.0664 x 0.1445 m).
    screen: { material: "screen", aspect: 1206 / 2622 },
    colours: [
      // Silver is the authored (no-override) finish; the other two are the exported glbs' baseColorFactors per colour .blend, extracted 2026-07-15 via scripts/dump-glb-materials.mjs, linear to sRGB hex. "aluminum satin" also covers "aluminum rough" (identical in Silver, deduped at optimise).
      { id: "silver", name: "Silver", overrides: {}, swatch: "#bfbebb" },
      {
        id: "cosmic-orange",
        name: "Cosmic Orange",
        overrides: {
          "aluminum satin": { color: "#cc6433" },
          "aluminum polished": { color: "#cc612f" },
          "screw grooves": { color: "#cc612f" },
          "glass cover rear": { color: "#eb733b" },
          "glass logo rear": { color: "#cc6433" },
          "antennas & connector": { color: "#e67039" },
          "camera button": { color: "#cc6433" },
        },
        swatch: "#cc6433",
      },
      {
        id: "deep-blue",
        name: "Deep Blue",
        overrides: {
          "aluminum satin": { color: "#323440" },
          "aluminum polished": { color: "#323440" },
          "screw grooves": { color: "#3c3e4d" },
          "glass cover rear": { color: "#393c4d" },
          "glass logo rear": { color: "#282b39" },
          "antennas & connector": { color: "#393d52" },
          "camera button": { color: "#464959" },
        },
        swatch: "#323440",
      },
    ],
    defaultColour: "silver",
    previews: {
      silver: preview17Silver,
      "cosmic-orange": preview17Orange,
      "deep-blue": preview17Blue,
    },
  },
  "macbook-pro-16": {
    id: "macbook-pro-16",
    name: "MacBook Pro 16″",
    form: "laptop",
    glbUrl: macbookPro16ModelUrl,
    // 3456 x 2234 display, landscape; matches the measured screen mesh (0.3456 x 0.2234 m).
    screen: { material: "SCREEN.001", aspect: 3456 / 2234 },
    colours: [
      // Silver is the authored (no-override) finish; Space Grey per the vendor's colour .blend (same extraction as the iPhones).
      { id: "silver", name: "Silver", overrides: {}, swatch: "#898989" },
      {
        id: "space-grey",
        name: "Space Grey",
        overrides: {
          "ALUMINUM Silver": { color: "#5e5e61" },
          TRACKPAD: { color: "#5e5e61" },
        },
        swatch: "#5e5e61",
      },
    ],
    defaultColour: "silver",
    previews: {
      silver: previewMbpSilver,
      "space-grey": previewMbpGrey,
    },
    // A laptop's bbox height depends on the lid angle; width is the stable hero extent.
    fit: { axis: "width", target: 3.4 },
    // DISPLAY.001 in the glb ("DISPLAY001" after three.js name sanitising), authored open at 110 degrees.
    lid: { node: "DISPLAY001", openDeg: 110, defaultDeg: 90 },
  },
  "iphone-15-pro": {
    id: "iphone-15-pro",
    name: "iPhone 15 Pro",
    form: "phone",
    glbUrl: phoneModelUrl,
    // 2556 × 1179 display, portrait.
    screen: { material: "SCREEN", aspect: 1179 / 2556 },
    colours: [
      // Natural titanium is the authored (no-override) finish; the other three are the vendor .blends' baseColorFactors, extracted 2026-07-05 via headless Blender inspect, linear to sRGB hex (max round-trip error 0.0022 linear).
      titaniumColour("natural-titanium", "Natural Titanium", null),
      titaniumColour("blue-titanium", "Blue Titanium", {
        frame: "#404850",
        backRough: "#383e45",
        backPolished: "#4d5763",
        antennas: "#2b3138",
        inlay: "#383e45",
      }),
      titaniumColour("white-titanium", "White Titanium", {
        frame: "#b3b2ab",
        backRough: "#b3b2ab",
        backPolished: "#e7e6e2",
        antennas: "#a09e98",
        inlay: "#a09e98",
      }),
      titaniumColour("black-titanium", "Black Titanium", {
        frame: "#61605e",
        backRough: "#484846",
        backPolished: "#5d5d5c",
        antennas: "#454543",
        inlay: "#454543",
      }),
    ],
    defaultColour: "natural-titanium",
    previews: {
      "natural-titanium": previewNatural,
      "blue-titanium": previewBlue,
      "white-titanium": previewWhite,
      "black-titanium": previewBlack,
    },
  },
};

export const DEVICE_IDS = Object.keys(DEVICE_CATALOG) as DeviceId[];

export function isDeviceId(id: string): id is DeviceId {
  return id in DEVICE_CATALOG;
}

/** Custom-tint colour ids: `"custom:#rrggbb"` in the sidecar's `colour` slot. */
export const CUSTOM_COLOUR_PREFIX = "custom:";

/** The hex behind a custom colour id, or undefined for catalogue ids. */
export function customColourHex(colourId: string | undefined): string | undefined {
  const hex = colourId?.startsWith(CUSTOM_COLOUR_PREFIX)
    ? colourId.slice(CUSTOM_COLOUR_PREFIX.length)
    : undefined;
  return hex && /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : undefined;
}

type Hsl = { h: number; s: number; l: number };

function hexToHsl(hex: string): Hsl {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const to255 = (v: number) => Math.round((v + m) * 255);
  return `#${((to255(r) << 16) | (to255(g) << 8) | to255(b)).toString(16).padStart(6, "0")}`;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Custom tint: the model's first overriding finish supplies each material's saturation/lightness offset from its frame colour, re-applied around the user's hex, so the finish structure (polished lighter, antennas darker) survives an arbitrary hue. Pure maths, deterministic per (model, hex). */
function customFinish(spec: DeviceSpec, hex: string): DeviceColourSpec {
  const overrides: Record<string, DeviceMaterialOverride> = {};
  const ref = spec.colours.find((c) => Object.keys(c.overrides).length > 0);
  if (ref) {
    const base = hexToHsl(ref.swatch);
    const target = hexToHsl(hex);
    for (const [material, override] of Object.entries(ref.overrides)) {
      if (!override.color) continue;
      const m = hexToHsl(override.color);
      overrides[material] = {
        color: hslToHex({
          h: target.h,
          s: clamp01(target.s + (m.s - base.s)),
          l: clamp01(target.l + (m.l - base.l)),
        }),
      };
    }
  }
  return { id: CUSTOM_COLOUR_PREFIX + hex, name: "Custom", overrides, swatch: hex };
}

/** Resolve a colour spec, degrading to the model's default on unknown ids. */
export function deviceColour(spec: DeviceSpec, colourId: string | undefined): DeviceColourSpec {
  const custom = customColourHex(colourId);
  if (custom) return customFinish(spec, custom);
  const found = colourId && spec.colours.find((c) => c.id === colourId);
  return found || spec.colours.find((c) => c.id === spec.defaultColour) || spec.colours[0];
}

/** Barrier: awaits every catalog model fetched + parsed before frame 0 and warms drei's `useGLTF` cache (see docs/determinism.md); throws on zero textured materials since GLTFLoader silently drops textures when embedded-image decode fails (the CSP-blocked blob: fetch regression that once shipped bald devices). */
export async function preloadCatalogModels(): Promise<void> {
  const loader = new GLTFLoader();
  const urls = [...new Set(Object.values(DEVICE_CATALOG).map((s) => s.glbUrl))];
  await Promise.all(
    urls.map(async (url) => {
      useGLTF.preload(url);
      const gltf = await loader.loadAsync(url);
      let textured = 0;
      gltf.scene.traverse((obj) => {
        const mat = (obj as Mesh).material as MeshStandardMaterial | undefined;
        if (mat?.isMeshStandardMaterial && (mat.map || mat.normalMap)) textured++;
      });
      if (textured === 0) {
        throw new Error(
          `Device model "${url}" parsed with NO textured materials — embedded texture ` +
            "decode failed (is `connect-src blob:` missing from the CSP?). " +
            "See docs/determinism.md (Packaged-app parity: the CSP is render contract).",
        );
      }
    }),
  );
}
