import { useUiStore } from "../store/uiStore";
import type { GizmoDomain } from "./gizmoRegistry";

/** Which inspector section an item's gizmo chrome belongs to: outlines and click-to-select appear for a whole domain while any drill in its family is open, and the selected item then shows handles. Pure over the drill stack, so the canvas can read it (the LightHelpers precedent) and the export path never touches it. */

/** Drill-id prefixes to domains; a family match is `id === prefix` or `id.startsWith(prefix + ".")`. */
const PREFIXES: ReadonlyArray<readonly [string, GizmoDomain]> = [
  ["device", "devices"],
  ["objects", "objects"],
  ["chart", "chart"],
];

export function gizmoDomainForDrill(id: string | null | undefined): GizmoDomain | null {
  if (!id) return null;
  for (const [prefix, domain] of PREFIXES) {
    if (id === prefix || id.startsWith(`${prefix}.`)) return domain;
  }
  return null;
}

/** Top down, first match wins, so a drill that carries another family's id (Shadow lives under Device as `style.shadow`) still reads as the section the user drilled through. */
export function gizmoDomainForDrillStack(stack: readonly string[]): GizmoDomain | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    const domain = gizmoDomainForDrill(stack[i]);
    if (domain) return domain;
  }
  return null;
}

/** A boolean selector, so a drill change inside the same family re-renders nothing. */
export function useGizmoSectionOpen(domain: GizmoDomain): boolean {
  return useUiStore((s) => gizmoDomainForDrillStack(s.inspector.drillStack) === domain);
}
