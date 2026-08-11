import type { TextAnimationSpec } from "../theme/tokens";
import type { FormatInfo } from "../toolkit/types";
import type {
  SceneDoc,
  SceneManagedTextItem,
  SceneManagedTextItemType,
  SceneManagedTextMarker,
  SceneManagedTextPoint,
} from "./sceneDocSchema";

export interface VirtualManagedTextRegistration {
  key: string;
  /** Resolved copy, including the mounted primitive's fallback when the sidecar has no value. */
  text: string;
  type?: SceneManagedTextItemType;
  points?: SceneManagedTextPoint[];
  icon?: string;
  /** Resolved code-owned style, captured before takeover. */
  style?: {
    color?: string;
    font?: string;
    size?: number;
    offsetX?: number;
    offsetY?: number;
    lineHeight?: number;
    rotationDeg?: number;
  };
  /** Resolved code-owned motion, captured as an item exception before takeover. */
  motion?: TextAnimationSpec;
}

export interface VirtualManagedTextOptions {
  /** Resolved header icon. Overlay callers pass the frame icon; plain scenes can omit it. */
  icon?: string;
  iconKey?: string;
}

export interface ManagedTextModel {
  ownership: "authored" | "managed";
  items: SceneManagedTextItem[];
  textStyle?: Record<string, string | number>;
  textAnimationOverrides?: Record<string, TextAnimationSpec>;
}

export type ManagedTextRenderRole = "scene" | "embedded" | "managed";

export function managedTextOwnsScene(doc: SceneDoc | null | undefined): boolean {
  return doc?.managedText !== undefined;
}

/** Code-owned scene text stands down on takeover; embedded compositions and managed nodes remain. */
export function shouldRenderManagedTextRole(
  doc: SceneDoc | null | undefined,
  role: ManagedTextRenderRole,
): boolean {
  return !managedTextOwnsScene(doc) || role !== "scene";
}

export function inferManagedTextType(key: string): SceneManagedTextItemType {
  const value = key.toLowerCase();
  if (value.includes("icon") || value.includes("emoji") || value.includes("logo")) return "icon";
  if (value.includes("bullet") || value.includes("point") || value.includes("list")) {
    return "bullets";
  }
  if (
    value.includes("subtitle") ||
    value === "sub" ||
    value.includes("body") ||
    value.includes("caption") ||
    value.includes("description") ||
    value.includes("tagline")
  ) {
    return "subtitle";
  }
  return "title";
}

function pointKey(itemKey: string, index: number): string {
  return `${itemKey}-point-${index + 1}`;
}

function pointsFromText(itemKey: string, text: string): SceneManagedTextPoint[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => ({ key: pointKey(itemKey, index), text: line }));
}

function virtualItem(registration: VirtualManagedTextRegistration): SceneManagedTextItem {
  const type = registration.type ?? inferManagedTextType(registration.key);
  return {
    key: registration.key,
    type,
    text: registration.text,
    ...(type === "bullets"
      ? { points: registration.points ?? pointsFromText(registration.key, registration.text) }
      : registration.points
        ? { points: registration.points }
        : {}),
    ...(registration.icon !== undefined ? { icon: registration.icon } : {}),
  };
}

function unusedKey(preferred: string, used: Set<string>): string {
  if (!used.has(preferred)) return preferred;
  let suffix = 2;
  while (used.has(`${preferred}-${suffix}`)) suffix++;
  return `${preferred}-${suffix}`;
}

/** Derives the pre-takeover list without writing. Existing managed blocks always win, including present-empty. */
export function deriveManagedTextModel(
  doc: SceneDoc,
  registrations: readonly VirtualManagedTextRegistration[] = [],
  options: VirtualManagedTextOptions = {},
): ManagedTextModel {
  if (doc.managedText !== undefined) {
    return { ownership: "managed", items: doc.managedText.items };
  }
  const items: SceneManagedTextItem[] = [];
  const textStyle: Record<string, string | number> = {};
  const textAnimationOverrides: Record<string, TextAnimationSpec> = {};
  const used = new Set<string>();
  const icon = options.icon ?? doc.headerIcon;
  if (icon) {
    const key = unusedKey(options.iconKey ?? "icon", used);
    used.add(key);
    items.push({ key, type: "icon", icon });
  }
  for (const registration of registrations) {
    if (!registration.key.trim() || used.has(registration.key)) continue;
    used.add(registration.key);
    items.push(
      virtualItem({
        ...registration,
        text: doc.text?.[registration.key] ?? registration.text,
      }),
    );
    const style = registration.style;
    if (style) {
      const values: [string, string | number | undefined][] = [
        ["Color", style.color],
        ["Font", style.font],
        ["Size", style.size],
        ["OffsetX", style.offsetX],
        ["OffsetY", style.offsetY],
        ["LineHeight", style.lineHeight],
        ["RotationDeg", style.rotationDeg],
      ];
      for (const [suffix, value] of values) {
        if (value !== undefined) textStyle[`${registration.key}${suffix}`] = value;
      }
    }
    if (registration.motion) textAnimationOverrides[registration.key] = registration.motion;
  }
  for (const [key, text] of Object.entries(doc.text ?? {})) {
    if (used.has(key)) continue;
    used.add(key);
    items.push(virtualItem({ key, text }));
  }
  return {
    ownership: "authored",
    items,
    ...(Object.keys(textStyle).length > 0 ? { textStyle } : {}),
    ...(Object.keys(textAnimationOverrides).length > 0 ? { textAnimationOverrides } : {}),
  };
}

function cloneItem(item: SceneManagedTextItem): SceneManagedTextItem {
  return {
    ...item,
    ...(item.points ? { points: item.points.map((point) => ({ ...point })) } : {}),
  };
}

/** Materialises one virtual snapshot while retaining every authored field for exact undo/removal. */
export function materialiseManagedText(doc: SceneDoc, model: ManagedTextModel): SceneDoc {
  if (doc.managedText !== undefined) return doc;
  const textStyle = model.textStyle ? { ...model.textStyle, ...doc.textStyle } : doc.textStyle;
  const textAnimationOverrides = model.textAnimationOverrides
    ? { ...model.textAnimationOverrides, ...doc.textAnimationOverrides }
    : doc.textAnimationOverrides;
  return {
    ...doc,
    managedText: { items: model.items.map(cloneItem) },
    ...(textStyle && Object.keys(textStyle).length > 0 ? { textStyle } : {}),
    ...(textAnimationOverrides && Object.keys(textAnimationOverrides).length > 0
      ? { textAnimationOverrides }
      : {}),
  };
}

export interface ManagedTextRegion {
  left: number;
  top: number;
  bottom: number;
  width: number;
  align?: "left" | "center" | "right";
}

export type ManagedTextRenderNodeKind =
  | "title"
  | "subtitle"
  | "icon"
  | "bullet-marker"
  | "bullet-text";

export interface ManagedTextRenderNode {
  key: string;
  itemKey: string;
  kind: ManagedTextRenderNodeKind;
  text?: string;
  icon?: string;
  position: [number, number, number];
  fontSize: number;
  maxWidth: number;
  anchorX: "left" | "center" | "right";
  face: "headline" | "body";
  from: number;
  to: number;
}

export interface ManagedTextRenderPlan {
  ownsSceneText: boolean;
  nodes: ManagedTextRenderNode[];
  fit: number;
}

function safeRegion(format: FormatInfo, align: ManagedTextRegion["align"]): ManagedTextRegion {
  return {
    left: -format.frame.width / 2 + format.safe.left,
    top: format.frame.height / 2 - format.safe.top,
    bottom: -format.frame.height / 2 + format.safe.bottom,
    width: Math.max(0, format.frame.width - format.safe.left - format.safe.right),
    align,
  };
}

function lineCount(text: string, fontSize: number, maxWidth: number): number {
  const perLine = Math.max(1, Math.floor(maxWidth / Math.max(0.001, fontSize * 0.56)));
  return Math.max(
    1,
    text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0),
  );
}

function markerText(marker: SceneManagedTextMarker | undefined, index: number): string {
  switch (marker ?? "dot") {
    case "dash":
      return "–";
    case "tick":
      return "✓";
    case "number":
      return `${index + 1}.`;
    case "none":
      return "";
    default:
      return "•";
  }
}

interface ItemMeasure {
  item: SceneManagedTextItem;
  size: number;
  height: number;
  pointHeights: number[];
  pointGap: number;
}

/** Pure render data for the deterministic safe-area stack. An absent block returns no ownership; present-empty owns and emits no nodes. */
export function resolveManagedTextRenderPlan(
  doc: SceneDoc | null | undefined,
  format: FormatInfo,
  themeScale: number,
  suppliedRegion?: ManagedTextRegion,
  themeMotion?: TextAnimationSpec,
): ManagedTextRenderPlan {
  if (doc?.managedText === undefined) return { ownsSceneText: false, nodes: [], fit: 1 };
  const align = suppliedRegion?.align ?? doc.textLayout?.align ?? "center";
  const region = suppliedRegion ?? safeRegion(format, align);
  const height = Math.max(0, region.top - region.bottom);
  const titleCap = format.aspect < 1 ? 0.34 : 0.56;
  const baseTitle = Math.max(0.01, Math.min(titleCap, region.width * 0.18, height * 0.14));
  const gap = baseTitle * 0.34;
  const measures: ItemMeasure[] = doc.managedText.items.map((item) => {
    const baseSize =
      item.type === "title"
        ? baseTitle
        : item.type === "icon"
          ? baseTitle * 1.15
          : baseTitle / Math.max(1, themeScale) ** 4;
    const size = baseSize;
    const pointGap = item.pointGap ?? size * 0.35;
    if (item.type === "bullets") {
      const pointHeights = (item.points ?? []).map(
        (point) => lineCount(point.text, size, region.width) * size * 1.28,
      );
      return {
        item,
        size: baseSize,
        pointHeights,
        pointGap,
        height:
          pointHeights.reduce((sum, value) => sum + value, 0) +
          Math.max(0, pointHeights.length - 1) * pointGap,
      };
    }
    const content = item.type === "icon" ? (item.icon ?? item.text ?? "") : (item.text ?? "");
    return {
      item,
      size: baseSize,
      pointHeights: [],
      pointGap,
      height:
        item.type === "icon"
          ? size * 1.15
          : lineCount(content, size, region.width) * size * (item.type === "title" ? 1.18 : 1.28),
    };
  });
  const nominalHeight =
    measures.reduce((sum, measure) => sum + measure.height, 0) +
    Math.max(0, measures.length - 1) * gap;
  const fit = nominalHeight > 0 ? Math.min(1, height / nominalHeight) : 1;
  const stackHeight = nominalHeight * fit;
  let cursor = region.top - Math.max(0, (height - stackHeight) / 2);
  const anchorX = align;
  const x =
    align === "left"
      ? region.left
      : align === "right"
        ? region.left + region.width
        : region.left + region.width / 2;
  const nodes: ManagedTextRenderNode[] = [];
  let deliveryLineIndex = 0;
  for (const measure of measures) {
    const { item } = measure;
    const size = measure.size * fit;
    const motion = doc.textAnimationOverrides?.[item.key] ?? doc.textAnimation ?? themeMotion;
    const lineStagger =
      motion?.delivery === "by-paragraph" || motion?.delivery === "by-paragraph-group"
        ? Math.max(0, motion.staggerMs)
        : 0;
    const from = 200 + deliveryLineIndex * lineStagger;
    const to = 900 + deliveryLineIndex * lineStagger;
    if (item.type === "icon") {
      const icon = item.icon ?? item.text ?? "";
      if (icon) {
        nodes.push({
          key: item.key,
          itemKey: item.key,
          kind: "icon",
          icon,
          position: [x, cursor, 0],
          fontSize: size,
          maxWidth: region.width,
          anchorX,
          face: "headline",
          from,
          to,
        });
      }
    } else if (item.type === "bullets") {
      let pointTop = cursor;
      const indent = (item.indent ?? measure.size * 1.35) * fit;
      for (let pointIndex = 0; pointIndex < (item.points ?? []).length; pointIndex++) {
        const point = item.points?.[pointIndex];
        if (!point) continue;
        const marker = markerText(item.marker, pointIndex);
        const bulletX = region.left;
        const pointFrom = from + pointIndex * lineStagger;
        const pointTo = to + pointIndex * lineStagger;
        if (marker) {
          nodes.push({
            key: `${item.key}:${point.key}:marker`,
            itemKey: item.key,
            kind: "bullet-marker",
            text: marker,
            position: [bulletX, pointTop, 0],
            fontSize: size,
            maxWidth: indent,
            anchorX: "left",
            face: "body",
            from: pointFrom,
            to: pointTo,
          });
        }
        if (point.text) {
          nodes.push({
            key: `${item.key}:${point.key}:text`,
            itemKey: item.key,
            kind: "bullet-text",
            text: point.text,
            position: [bulletX + (marker ? indent : 0), pointTop, 0],
            fontSize: size,
            maxWidth: region.width - (marker ? indent : 0),
            anchorX: "left",
            face: "body",
            from: pointFrom,
            to: pointTo,
          });
        }
        pointTop -= (measure.pointHeights[pointIndex] ?? 0) * fit + measure.pointGap * fit;
      }
    } else {
      const text = item.text ?? "";
      if (text) {
        nodes.push({
          key: item.key,
          itemKey: item.key,
          kind: item.type,
          text,
          position: [x, cursor, 0],
          fontSize: size,
          maxWidth: region.width,
          anchorX,
          face: item.type === "title" ? "headline" : "body",
          from,
          to,
        });
      }
    }
    cursor -= measure.height * fit + gap * fit;
    deliveryLineIndex += item.type === "bullets" ? Math.max(1, item.points?.length ?? 0) : 1;
  }
  return { ownsSceneText: true, nodes, fit };
}
