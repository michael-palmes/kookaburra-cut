import type { ComponentType } from "react";

/** One tunable number on a 3D background look (the inspector renders a slider per entry). */
export interface Scene3dParamDef {
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
}

/** Resolved props a look component receives: hex colours in slot order, params with defaults filled, and the speed multiplier for the ABSOLUTE project clock. */
export interface Scene3dLookProps {
  colors: string[];
  params: Record<string, number>;
  speed: number;
}

/** A world-space animated background look: real geometry mounted inside the scene's identity group (so it parallaxes with camera rigs), staged OUTSIDE the content volume (x/y roughly +-4/+-2, z -6..9) with a keep-out clearance and a distance fade so text, devices and stacks never clip through it. Unlit looks follow the backdrop exact-colour discipline (toneMapped false); `lit` looks respond to the scene's v9 lighting. Motion must be a pure function of the deterministic clock (useTimeline / clock store), never the wall clock. */
export interface Scene3dBackgroundDef {
  id: string;
  name: string;
  /** True when materials respond to scene lighting; absent = unlit exact colours. */
  lit?: boolean;
  /** Ordered colour slots with hex fallbacks: the look's first DARK preset (p6), matching the shader-background convention (docs/backgrounds.md). */
  colorSlots: { label: string; fallback: string }[];
  params: Record<string, Scene3dParamDef>;
  Component: ComponentType<Scene3dLookProps>;
}
