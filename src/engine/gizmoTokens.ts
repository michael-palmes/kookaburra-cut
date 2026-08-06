import { Color, type Material, type Mesh, type Object3D } from "three";

/** The gizmo palette. Mirrors the `--gizmo-*` custom properties in styles.css; three cannot read CSS variables, so the two are kept in step by hand. A deliberate exception to design.md §14 (rendered-video colours never live in chrome files): a gizmo is chrome that happens to draw in the canvas. */
export const GIZMO_COLOURS = {
  /** X: --danger, the warm axis. */
  axisX: "#e5654b",
  /** Y: --success. */
  axisY: "#5fb87a",
  /** Z: --accent-hover, light enough to read against the dark stage. */
  axisZ: "#82a7bb",
  /** Hovered or dragging handle, the same yellow as the 2D alignment guides. */
  active: "#ffd60a",
} as const;

/** TransformControls `size`, the value every gizmo host passes. */
export const GIZMO_SIZE = 1.8;

/** three-stdlib's stock gizmo palette mapped to ours. Keyed by the material's own colour, not by handle name: one material serves several handles, and handles with different names share one material. */
const SWAP = new Map<number, string>([
  [0xff0000, GIZMO_COLOURS.axisX],
  [0x00ff00, GIZMO_COLOURS.axisY],
  [0x0000ff, GIZMO_COLOURS.axisZ],
  [0xffff00, GIZMO_COLOURS.active],
]);

/** three-stdlib's gizmo restores each handle from a lazily captured `tempColor` every frame, so `color` alone gets stomped on the next one. */
type GizmoMaterial = Material & { color?: Color; tempColor?: Color };

function restyleMaterial(mat: GizmoMaterial): void {
  if (!mat.color) return;
  const swap = SWAP.get((mat.tempColor ?? mat.color).getHex());
  if (!swap) return;
  mat.color.set(swap);
  if (!mat.tempColor) mat.tempColor = new Color();
  mat.tempColor.set(swap);
}

/** Recolour a three-stdlib TransformControls onto the app palette. Idempotent (the replacement hexes are not keys in `SWAP`), so it can run on every mode change with no bookkeeping; the plane handles' cyan/magenta and the helper lines' grey stay stock. */
export function restyleTransformControls(controls: Object3D | null | undefined): void {
  controls?.traverse((o) => {
    const mat = (o as Mesh).material as GizmoMaterial | GizmoMaterial[] | undefined;
    if (!mat) return;
    if (Array.isArray(mat)) for (const m of mat) restyleMaterial(m);
    else restyleMaterial(mat);
  });
}
