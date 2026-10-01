import type { ComponentType } from "react";
import type { LightingSpec } from "../../../theme/tokens";
import type { Scene3dFamily } from "./families";

/** One tunable number on a 3D background look (the inspector renders a slider per entry). Resolved values clamp to `min`..`max` (`resolveScene3dParams`). */
export interface Scene3dParamDef {
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
}

/** Resolved props a look component receives: hex colours in slot order, params with defaults filled, the speed multiplier for the ABSOLUTE project clock, and the backing as one hex. */
export interface Scene3dLookProps {
  colors: string[];
  params: Record<string, number>;
  speed: number;
  /** What sits behind the look as one sRGB hex (`resolveScene3dBackingTone`): mix distance fades toward it instead of fading alpha or guessing a tone. */
  backing: string;
}

/** One geometry colour slot; `fallback` is the look's first DARK preset (p6), matching the shader-background convention (docs/backgrounds.md). */
export interface Scene3dColorSlot {
  label: string;
  fallback: string;
  /** Small emissive areas kept out of the text band: dark presets may reach luminance 0.30 here. At most 2 per look. */
  glow?: boolean;
}

/** A world-space animated background look: real geometry mounted inside the scene's identity group (so it parallaxes with camera rigs), staged OUTSIDE the content volume (x/y roughly +-4/+-2, z -6..9) with a keep-out clearance and a distance fade so text, devices and stacks never clip through it. Unlit looks follow the backdrop exact-colour discipline (toneMapped false); `lit` looks respond to the scene's v9 lighting. Motion must be a pure function of the deterministic clock (useTimeline / clock store), never the wall clock. */
export interface Scene3dBackgroundDef {
  id: string;
  name: string;
  /** Picker group (SCENE3D_FAMILIES). */
  family: Scene3dFamily;
  /** True when materials respond to scene lighting; absent = unlit exact colours. */
  lit?: boolean;
  colorSlots: Scene3dColorSlot[];
  params: Record<string, Scene3dParamDef>;
  /** Generated preview-lab camera: `static` holds one elevated pose, `sweep` orbits the type-card clip. Absent: static for grids, sweep otherwise. */
  previewCamera?: "static" | "sweep";
  Component: ComponentType<Scene3dLookProps>;
}

/** A preset's matching v9 rig, written into the scene lighting layer by the Matching lighting toggle (off by default). Static fields only: no keyframes, legacy fills or picker metadata. */
export type Scene3dCompanionLighting = Pick<
  LightingSpec,
  "environment" | "sun" | "ambient" | "ambientColor" | "lights" | "fixtures" | "shadow"
>;

export interface Scene3dBackgroundPreset {
  /** Look-scoped id (p1..p9); pair with the look id, never unique alone. */
  id: string;
  name: string;
  /** Light presets carry black text at AA; dark presets carry white. */
  mode: "light" | "dark";
  /** AA-checked text colour over every stop (card metadata / contrast hints). */
  textColor: string;
  /** One hex per geometry colour slot, in slot order. */
  colors: string[];
  /** Flat backing colour stamped as `backing: { type: "color" }` on apply. */
  backing: string;
  speed?: number;
  params?: Record<string, number>;
  lighting?: Scene3dCompanionLighting;
}

/** What `looks/<id>/index.ts` exports: the def (its `id` is the folder name) and its 9 presets. */
export interface Scene3dLookModule {
  look: Scene3dBackgroundDef;
  presets: Scene3dBackgroundPreset[];
}
