import { useLayoutEffect, useRef } from "react";
import type { Group } from "three";
import { useTheme } from "../../../theme";
import type { ThemeBackground } from "../../../theme/tokens";
import { SCENE3D_RENDER_ORDER } from "../fixedMath";
import { deriveThemeColorsFromAnchor } from "../shaders/themePreset";
import { resolveScene3dBackingTone } from "./backing";
import { SCENE3D_BACKGROUNDS } from "./index";
import { resolveScene3dParams } from "./params";
import { scene3dThemeAnchor } from "./presets";

/** World-space 3D background mount: resolves geometry colours (theme-derived, explicit, or slot fallbacks), params clamped to the def's bounds and the backing's one-hex tone, then renders the look inside the scene's identity group so it parallaxes with camera rigs. The nested `backing` 2D fill is mounted by FixedBackdrop's scene3d case, not here. Unknown look ids degrade to nothing (the parser is schema-light by design). */
export function Scene3dBackdrop({ spec }: { spec: Extract<ThemeBackground, { type: "scene3d" }> }) {
  const theme = useTheme();
  const rootRef = useRef<Group>(null);
  // Backgrounds never overdraw content: transparent look geometry (grid lines especially) spans huge bounds, so per-object distance sorting can flip it in front of the video window or cards at oblique angles; stamping every renderable early in the transparent pass pins the layering. Runs each commit, so a look that restructures stays stamped.
  useLayoutEffect(() => {
    rootRef.current?.traverse((o) => {
      // Renderables only: three.js reads a group's renderOrder as groupOrder, which outranks renderOrder in the sort, so a stamped group would drag opaque look geometry in front of the backing quad and get painted over.
      if ((o as { isGroup?: boolean }).isGroup) return;
      o.renderOrder = SCENE3D_RENDER_ORDER;
    });
  });
  const def = SCENE3D_BACKGROUNDS[spec.look];
  if (!def) {
    console.warn(`[stage] 3D background "${spec.look}" not found — no background`);
    return null;
  }
  const anchor = spec.themeColors ? scene3dThemeAnchor(spec.look, theme) : undefined;
  const themeDerived = anchor ? deriveThemeColorsFromAnchor(anchor.colors, theme) : null;
  const colors = def.colorSlots.map(
    (slot, i) => (themeDerived ?? spec.colors)?.[i] ?? slot.fallback,
  );
  const params = resolveScene3dParams(def.params, spec.params);
  const backing = resolveScene3dBackingTone(spec.backing, theme);
  return (
    <group ref={rootRef}>
      <def.Component colors={colors} params={params} speed={spec.speed ?? 1} backing={backing} />
    </group>
  );
}
