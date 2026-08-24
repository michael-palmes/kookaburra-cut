/** Where the scene's world actually lands on screen. An overlay renders the scene into a cutout-sized target and keys it into the cutout's rect (docs/overlays.md), so the canvas box is NOT the rect a world projection maps onto: every editor surface that turns world coordinates into client pixels, or client pixels back into a ray, reads its rect from here. Pure geometry plus one published cutout; the export path never imports it. See docs/gizmos.md. */

import { type FrameRect, frameLayout } from "../toolkit/frame/frameLayout";
import type { FrameSpec } from "../toolkit/frame/types";
import { framesThroughCutout } from "./frameFormat";
import type { StageRect } from "./gizmoRegistry";

let published: FrameRect | null = null;

/** The cutout the world renders into for the scene at the playhead, or null when the world fills the frame (every unframed scene). Published by the editor shell, read by the gizmo surfaces. */
export function setStageCutout(cutout: FrameRect | null): void {
  published = cutout;
}

export function stageCutout(): FrameRect | null {
  return published;
}

/** The cutout a framed scene's world renders into, or null when it renders full-bleed: only `shape: "none"` has no window. Shape-driven, matching the compositor's `usesSceneTarget` and `SceneHost`'s format narrowing, so the panel fill (transparent included) never moves the world. */
export function frameWorldCutout(frame: FrameSpec | undefined, aspect: number): FrameRect | null {
  if (!frame || !framesThroughCutout(frame)) return null;
  return frameLayout(aspect, frame.cutout).cutout;
}

/** The cutout in client pixels: the rect the scene is actually drawn into, which is what a frame-relative placement (`-1..1` against the cutout's own format) maps onto. Identity when no cutout is live. */
export function cutoutStageRect(frame: StageRect, cutout: FrameRect | null): StageRect {
  if (!cutout) return frame;
  return {
    left: frame.left + cutout.x * frame.width,
    top: frame.top + cutout.y * frame.height,
    width: cutout.width * frame.width,
    height: cutout.height * frame.height,
  };
}

/** The rect a projection through the LIVE camera maps its NDC onto. The camera carries the FRAME's aspect between compositor passes while the cutout pass renders at the cutout's, and a perspective x divides by the aspect, so the corrected rect is the cutout's height by the frame's aspect, centred on the cutout: `ndcToStagePx` and `stagePxToNdc` against it then land exactly the pixels the slide pass drew. Identity when no cutout is live, so unframed scenes see the numbers they always saw. */
export function worldViewportRect(frame: StageRect, cutout: FrameRect | null): StageRect {
  if (!cutout || frame.height <= 0) return frame;
  const drawn = cutoutStageRect(frame, cutout);
  const width = (drawn.height * frame.width) / frame.height;
  return {
    left: drawn.left + (drawn.width - width) / 2,
    top: drawn.top,
    width,
    height: drawn.height,
  };
}

function viewportDomRect(target: Element): DOMRect {
  const box = target.getBoundingClientRect();
  const rect = worldViewportRect(
    { left: box.left, top: box.top, width: box.width, height: box.height },
    published,
  );
  return {
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    toJSON: () => rect,
  } as DOMRect;
}

const proxies = new WeakMap<Element, HTMLCanvasElement>();

/** `TransformControls` maps client pixels to NDC through its dom element's own box, and drei hands it the canvas, whose box is the whole frame. In a framed scene the world is drawn into the cutout, so the control would hit-test against pixels it never drew on. This gives it the same element with `getBoundingClientRect` answering the world's viewport instead; every other property, the listeners included, is the canvas itself, and the rect is the canvas box exactly whenever no cutout is live. One proxy per element, so drei's control is not rebuilt each render. */
export function stageViewportElement(element: HTMLCanvasElement): HTMLCanvasElement {
  const existing = proxies.get(element);
  if (existing) return existing;
  const proxy = new Proxy(element, {
    get(target, prop) {
      if (prop === "getBoundingClientRect") return () => viewportDomRect(target);
      // The canvas itself is the receiver, so its own getters (style, ownerDocument) resolve against the real node.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  proxies.set(element, proxy);
  return proxy;
}
