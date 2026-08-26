import type { GizmoDomain } from "../../engine/gizmoRegistry";
import { gizmoDomainForDrillStack } from "../../engine/gizmoSections";
import type { InspectorState } from "../../store/uiStore";

/** Which surface a Delete keypress belongs to: the open content drill's own trash, the Scene overview's selected row, or nobody. `DecorationGizmo` binds Delete for the whole decorations domain, drilled in or not, so this never claims it. Pure over the inspector state so the one rule the key hangs off stays provable. */
export type ContentDeleteRoute = "drill" | "overview" | null;

/** Drill families whose header carries a trash AND whose gizmo does not bind Delete itself; the compare, video window and stack drills have no gizmo to select from. */
const DELETABLE_DRILL_DOMAINS = new Set<GizmoDomain>([
  "devices",
  "media",
  "objects",
  "chart",
  "text",
  "terminal",
]);

export function contentDeleteRoute(inspector: InspectorState): ContentDeleteRoute {
  if (inspector.tab !== "scene") return null;
  if (inspector.drillStack.length === 0) {
    const selection = inspector.overviewSelection;
    return selection && selection.domain !== "decorations" ? "overview" : null;
  }
  const domain = gizmoDomainForDrillStack(inspector.drillStack);
  return domain && DELETABLE_DRILL_DOMAINS.has(domain) ? "drill" : null;
}

/** The LIVE drill header's trash: the direct child skips the outgoing ghost page the nav shell parks under `.inspector-nav-overlay` mid-transition, which carries the same classes. */
export const INSPECTOR_REMOVE_ACTION_SELECTOR =
  ".inspector-nav-shell > .inspector-nav-page .inspector-drill-header-action.danger";

/** Clicks the open drill's trash, so the key and the pointer share one delete path. False when the header has none, or it is disabled mid-write. */
export function clickInspectorRemoveAction(): boolean {
  if (typeof document === "undefined") return false;
  const button = document.querySelector<HTMLButtonElement>(INSPECTOR_REMOVE_ACTION_SELECTOR);
  if (!button || button.disabled) return false;
  button.click();
  return true;
}
