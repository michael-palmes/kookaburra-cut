/** The PDF still's invisible text layer: every troika line a page shows, projected into normalised page coordinates (top-left origin) for search and copy. Approximate by design: positions come from troika's caret boxes, and 3D extruded text and per-unit shader opacity are not seen. Reads scene objects only, never renders. */

import type { Camera, Layers, Matrix4, Object3D } from "three";
import { PerspectiveCamera, Vector3 } from "three";
import { EMOJI_PUA_COUNT, EMOJI_PUA_START } from "../theme/symbolsCodepoints.generated";
import { cutoutPixelRect, frameLayout } from "../toolkit/frame/frameLayout";
import { applyCameraPose, baseCameraPose } from "./cameraTrack";
import { framesThroughCutout } from "./frameFormat";
import type { ResolvedOverlay } from "./overlayPlan";

/** One line of the text layer: normalised to the page, top-left origin, `h` the line's glyph box. */
export interface StillTextItem {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a camera's view lands on the page, normalised, top-left origin. */
export interface PageViewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextRoot {
  root: Object3D;
  /** Persistent layers keep their own flag; hosts and panels are toggled by the compositor around each draw, so theirs is not read. */
  rootVisibility: boolean;
  /** Posed as the page rendered it, with `matrixWorldInverse` and `projectionMatrix` current. */
  camera: Camera;
  viewport: PageViewport;
}

/** A line box in the text mesh's local units. */
export interface TextLineBox {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface TroikaTextLike {
  text: string;
  textRenderInfo?: {
    caretPositions?: ArrayLike<number> | null;
    blockBounds?: ArrayLike<number>;
    visibleBounds?: ArrayLike<number>;
  } | null;
  fillOpacity?: number;
  strokeWidth?: number | string;
  strokeOpacity?: number;
  outlineWidth?: number | string;
  outlineOpacity?: number;
}

const MIN_ALPHA = 0.05;
const MAX_ITEMS = 4000;
const MAX_CHARS = 2000;
const DEDUPE_EPS = 0.01;
const FULL: PageViewport = { x: 0, y: 0, w: 1, h: 1 };
const PUA_END = EMOJI_PUA_START + EMOJI_PUA_COUNT;

const isTroikaText = (obj: Object3D): obj is Object3D & TroikaTextLike => {
  const o = obj as Object3D & Partial<TroikaTextLike>;
  return typeof o.text === "string" && !!o.textRenderInfo;
};

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

/** Strips emoji placeholders and control characters, NFC-normalises and trims; caps at the native text layer's per-line limit. */
export function cleanStillText(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= EMOJI_PUA_START && code < PUA_END) continue;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  const text = out.normalize("NFC").replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, MAX_CHARS).join("");
}

/** Splits a troika block into lines from its per-character caret boxes (`[startX, endX, bottom, top]` each): a newline or a vertical jump past half a line starts the next line. Null when the layout carries no carets. */
export function troikaLines(
  text: string,
  carets: ArrayLike<number> | null | undefined,
): TextLineBox[] | null {
  if (!carets || carets.length < text.length * 4) return null;
  const lines: TextLineBox[] = [];
  let line: TextLineBox | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      line = null;
      continue;
    }
    const a = carets[i * 4];
    const b = carets[i * 4 + 1];
    const bottom = carets[i * 4 + 2];
    const top = carets[i * 4 + 3];
    if (a === 0 && b === 0 && bottom === 0 && top === 0) {
      if (line && /\s/.test(ch)) line.text += ch;
      continue;
    }
    if (line && Math.abs((bottom + top - line.y0 - line.y1) / 2) > (line.y1 - line.y0) / 2) {
      line = null;
    }
    if (!line) {
      line = { text: "", x0: Math.min(a, b), x1: Math.max(a, b), y0: bottom, y1: top };
      lines.push(line);
    }
    line.text += ch;
    line.x0 = Math.min(line.x0, a, b);
    line.x1 = Math.max(line.x1, a, b);
    line.y0 = Math.min(line.y0, bottom);
    line.y1 = Math.max(line.y1, top);
  }
  return lines;
}

function visibleUpTo(obj: Object3D, root: Object3D, rootVisibility: boolean): boolean {
  for (let o: Object3D | null = obj; o && o !== root; o = o.parent) {
    if (!o.visible) return false;
  }
  return !rootVisibility || root.visible;
}

/** Fill, stroke or outline: whichever shows most, times the material's own opacity. */
export function troikaTextAlpha(obj: Object3D & TroikaTextLike): number {
  const raw = (obj as { material?: unknown }).material;
  const materials = (Array.isArray(raw) ? raw : [raw]) as ({
    opacity?: number;
    visible?: boolean;
  } | null)[];
  const base = materials[materials.length - 1];
  if (base?.visible === false) return 0;
  const stroke = obj.strokeWidth ? (obj.strokeOpacity ?? 1) : 0;
  const outline = obj.outlineWidth ? (obj.outlineOpacity ?? 1) : 0;
  return (base?.opacity ?? 1) * Math.max(obj.fillOpacity ?? 1, stroke, outline);
}

const _v = new Vector3();

/** Projects a local line box through `matrixWorld` and `camera` into the viewport; null when a corner sits behind the camera or nothing lands on the page. */
export function projectLineBox(
  box: Pick<TextLineBox, "x0" | "x1" | "y0" | "y1">,
  matrixWorld: Matrix4,
  camera: Camera,
  viewport: PageViewport,
): Omit<StillTextItem, "text"> | null {
  const near = (camera as PerspectiveCamera).isPerspectiveCamera
    ? (camera as PerspectiveCamera).near
    : 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [cx, cy] of [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x0, box.y1],
    [box.x1, box.y1],
  ]) {
    _v.set(cx, cy, 0).applyMatrix4(matrixWorld).applyMatrix4(camera.matrixWorldInverse);
    if (_v.z >= -near) return null;
    _v.applyMatrix4(camera.projectionMatrix);
    const sx = viewport.x + ((_v.x + 1) / 2) * viewport.w;
    const sy = viewport.y + ((1 - _v.y) / 2) * viewport.h;
    minX = Math.min(minX, sx);
    maxX = Math.max(maxX, sx);
    minY = Math.min(minY, sy);
    maxY = Math.max(maxY, sy);
  }
  const x0 = Math.max(minX, viewport.x, 0);
  const y0 = Math.max(minY, viewport.y, 0);
  const x1 = Math.min(maxX, viewport.x + viewport.w, 1);
  const y1 = Math.min(maxY, viewport.y + viewport.h, 1);
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x: round5(x0), y: round5(y0), w: round5(x1 - x0), h: round5(y1 - y0) };
}

const near = (a: number, b: number) => Math.abs(a - b) < DEDUPE_EPS;

/** Drops repeats of the same text over the same box (chromatic echo meshes), then orders top to bottom, left to right. */
export function finishTextItems(items: readonly StillTextItem[]): StillTextItem[] {
  const out: StillTextItem[] = [];
  for (const item of items) {
    const echo = out.some(
      (o) =>
        o.text === item.text &&
        near(o.x, item.x) &&
        near(o.y, item.y) &&
        near(o.w, item.w) &&
        near(o.h, item.h),
    );
    if (!echo) out.push(item);
  }
  out.sort((a, b) => Math.round(a.y * 1000) - Math.round(b.y * 1000) || a.x - b.x);
  return out.slice(0, MAX_ITEMS);
}

/** Every visible troika line under `roots`, projected and finished. */
export function collectPageText(roots: readonly TextRoot[], layers: Layers): StillTextItem[] {
  const items: StillTextItem[] = [];
  for (const { root, rootVisibility, camera, viewport } of roots) {
    root.traverse((obj) => {
      if (!isTroikaText(obj)) return;
      if (!visibleUpTo(obj, root, rootVisibility) || !obj.layers.test(layers)) return;
      if (troikaTextAlpha(obj) < MIN_ALPHA) return;
      const info = obj.textRenderInfo;
      const bounds = info?.visibleBounds ?? info?.blockBounds;
      const lines =
        troikaLines(obj.text, info?.caretPositions) ??
        (bounds
          ? [{ text: obj.text, x0: bounds[0], y0: bounds[1], x1: bounds[2], y1: bounds[3] }]
          : []);
      for (const line of lines) {
        const text = cleanStillText(line.text);
        if (!text) continue;
        const rect = projectLineBox(line, obj.matrixWorld, camera, viewport);
        if (rect) items.push({ text, ...rect });
      }
    });
  }
  return finishTextItems(items);
}

/** The scene's registered strings when no line could be placed: searchable, unpositioned. */
export function fallbackPageText(strings: readonly string[]): StillTextItem[] {
  const seen = new Set<string>();
  const out: StillTextItem[] = [];
  for (const raw of strings) {
    for (const part of raw.split("\n")) {
      const text = cleanStillText(part);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push({ text, x: 0, y: 0, w: 1, h: 0.02 });
    }
  }
  return out.slice(0, MAX_ITEMS);
}

/** A clone of the live camera at its current pose with `aspect`, matrices current (the compositor leaves `matrixWorld` at whatever its last draw used). */
function viewCamera(camera: PerspectiveCamera, aspect: number): PerspectiveCamera {
  // Not recursive: camera-space lights may hang off the live camera.
  const view = new PerspectiveCamera().copy(camera, false);
  if (view.isPerspectiveCamera) {
    view.aspect = aspect;
    view.updateProjectionMatrix();
  }
  view.updateMatrixWorld(true);
  return view;
}

export interface PageTextInput {
  sceneIndex: number;
  hosts: readonly { index: number; side?: "b"; group: Object3D }[];
  framePanels: readonly { index: number; group: Object3D; hasSceneImages: boolean }[];
  persistent: readonly Object3D[];
  /** The live camera right after the page's draws: posed as the scene rendered. */
  camera: PerspectiveCamera;
  overlay: ResolvedOverlay | null;
  /** The page took the comparison path (overlays stand down, side A carries the text). */
  comparing: boolean;
  width: number;
  height: number;
}

/** The roots a solo page drew and how each one reached the page, mirroring `renderComposited`'s solo paths: the scene host (full frame, or through its cutout), its overlay panel (screen-locked at the base pose) and the persistent layers. */
export function pageTextRoots(input: PageTextInput): TextRoot[] {
  const { sceneIndex, camera, overlay, comparing, width, height } = input;
  const aspect = width / height;
  const posed = viewCamera(camera, aspect);
  const roots: TextRoot[] = [];
  const host = input.hosts.find((h) => h.index === sceneIndex && h.side !== "b");
  if (host) {
    if (comparing || !overlay) {
      roots.push({ root: host.group, rootVisibility: false, camera: posed, viewport: FULL });
    } else if (framesThroughCutout(overlay.frame)) {
      const px = cutoutPixelRect(frameLayout(aspect, overlay.frame.cutout).cutout, width, height);
      roots.push({
        root: host.group,
        rootVisibility: false,
        camera: viewCamera(camera, px.width / px.height),
        viewport: { x: px.x / width, y: px.y / height, w: px.width / width, h: px.height / height },
      });
    } else if (overlay.panel.kind === "transparent") {
      roots.push({ root: host.group, rootVisibility: false, camera: posed, viewport: FULL });
    }
  }
  const panel = input.framePanels.find(
    (p) => p.index === sceneIndex && (!comparing || p.hasSceneImages),
  );
  if (panel) {
    const base = viewCamera(camera, aspect);
    applyCameraPose(base, baseCameraPose());
    base.updateMatrixWorld(true);
    roots.push({ root: panel.group, rootVisibility: false, camera: base, viewport: FULL });
  }
  for (const group of input.persistent) {
    roots.push({ root: group, rootVisibility: !comparing, camera: posed, viewport: FULL });
  }
  return roots;
}
