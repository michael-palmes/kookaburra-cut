import type { Object3D } from "three";

/** Whether an item is actually drawn right now. Every scene mounts at once and the compositor gates them by group visibility, which three's raycaster and a DOM overlay both ignore, so any editor chrome that follows a node has to ask. */

/** True while every ancestor is visible. `stopAt` ends the walk early and reports drawn: an overlay panel's group is left hidden between compositor passes, so its own subtree is judged on the ancestors below it. */
export function nodeDrawn(object: Object3D | null | undefined, stopAt?: Object3D | null): boolean {
  if (!object) return false;
  for (let o = object.parent; o; o = o.parent) {
    if (stopAt && o === stopAt) return true;
    if (!o.visible) return false;
  }
  return true;
}
