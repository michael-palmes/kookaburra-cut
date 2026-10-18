import { useEffect, useMemo } from "react";
import { DoubleSide, type Material, MeshBasicMaterial } from "three";
import { useEffectsStore } from "../../engine/effectsStore";

/** The project's `render.exactText`: troika text renders with tone mapping off on effect-free frames (the composer path tone-maps every pixel once regardless). */
export function useExactText(): boolean {
  return useEffectsStore((s) => s.renderSettings.exactText === true);
}

/** troika's own default text base (white, double-sided, transparent) with tone mapping off. */
export function createExactTextBase(): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide, transparent: true });
  material.toneMapped = false;
  return material;
}

/** The base material for a `Text` that has no stagger holder: built only under `render.exactText`, null otherwise so the default path never changes. */
export function useExactTextBase(): MeshBasicMaterial | null {
  const exact = useExactText();
  const base = useMemo(() => (exact ? createExactTextBase() : null), [exact]);
  useEffect(() => () => base?.dispose(), [base]);
  return base;
}

/** Spread onto a drei `Text`: names `material` only when there is one, so the default path passes no prop at all. */
export function materialProp(material: Material | null | undefined): { material?: Material } {
  return material ? { material } : {};
}
