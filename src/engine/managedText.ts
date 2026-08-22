import type { TextAnimationSpec } from "../theme/tokens";
import type { FormatInfo } from "../toolkit/types";
import {
  type CompareChipTextKey,
  compareChipGroupKey,
  compareChipRowLabel,
  compareChipTextItems,
  isCompareChipTextKey,
} from "./compareChipText";
import type {
  SceneDoc,
  SceneManagedTextGroup,
  SceneManagedTextItem,
  SceneManagedTextItemType,
  SceneManagedTextMarker,
  SceneManagedTextPoint,
  SceneTextAlign,
} from "./sceneDocSchema";

export const DEFAULT_MANAGED_TEXT_GROUP_KEY = "text";
export const MANAGED_TEXT_FRAME_ICON_KEY = "frameIcon";

const MANAGED_TEXT_STYLE_SUFFIXES = [
  "Color",
  "Font",
  "Size",
  "OffsetX",
  "OffsetY",
  "LineHeight",
  "RotationDeg",
] as const;

export interface ResolvedManagedTextGroup extends SceneManagedTextGroup {
  items: SceneManagedTextItem[];
  /** True only for the compatibility group derived from an absent `groups` field. */
  implicit: boolean;
  /** Host chrome (the comparison's label chips): editable as its own row, never written to the document's groups. */
  chrome?: boolean;
  /** Fixed row name for chrome groups, replacing the numbered "Text n" label. */
  label?: string;
}

/** True for a resolved group that only carries host chrome, so writers can drop it. */
export function isChromeManagedTextGroup(group: ResolvedManagedTextGroup): boolean {
  return group.chrome === true;
}

function chromeGroup(item: SceneManagedTextItem): ResolvedManagedTextGroup {
  const key = item.key as CompareChipTextKey;
  return {
    key: compareChipGroupKey(key),
    itemKeys: [item.key],
    items: [item],
    implicit: false,
    chrome: true,
    label: compareChipRowLabel(key),
  };
}

export function managedTextPoints(item: SceneManagedTextItem): SceneManagedTextPoint[] {
  if (item.type !== "bullets") return item.points ?? [];
  return item.points ?? pointsFromText(item.key, item.text ?? "");
}

function resolvedManagedTextItem(item: SceneManagedTextItem): SceneManagedTextItem {
  if (item.type !== "bullets" || item.points !== undefined) return item;
  return { ...item, points: managedTextPoints(item) };
}

/** Resolves Content-level groups without mutating flat leaf data or hiding unreferenced items. Host chrome (the comparison chips a model appends) rides one labelled single-item group each, after the content groups; `chromeKeys: []` reads a raw block, whose items are all owned. */
export function resolveManagedTextGroups(
  items: readonly SceneManagedTextItem[],
  groups?: readonly SceneManagedTextGroup[],
  chromeKeys?: readonly string[],
): ResolvedManagedTextGroup[] {
  const chrome = new Set(
    items
      .map((item) => item.key)
      .filter((key) => isCompareChipTextKey(key) && (chromeKeys?.includes(key) ?? true)),
  );
  const chromeGroups = items.filter((item) => chrome.has(item.key)).map(chromeGroup);
  const contentItems = items
    .filter((item) => item.key !== MANAGED_TEXT_FRAME_ICON_KEY && !chrome.has(item.key))
    .map(resolvedManagedTextItem);
  if (groups === undefined) {
    return [
      {
        key: DEFAULT_MANAGED_TEXT_GROUP_KEY,
        itemKeys: contentItems.map((item) => item.key),
        items: [...contentItems],
        implicit: true,
      },
      ...chromeGroups,
    ];
  }

  const itemByKey = new Map(contentItems.map((item) => [item.key, item]));
  const claimed = new Set<string>();
  const usedGroupKeys = new Set<string>();
  const resolved: ResolvedManagedTextGroup[] = [];
  for (const group of groups) {
    if (!group.key.trim() || usedGroupKeys.has(group.key)) continue;
    usedGroupKeys.add(group.key);
    const groupItems: SceneManagedTextItem[] = [];
    const itemKeys: string[] = [];
    for (const itemKey of group.itemKeys) {
      const item = itemByKey.get(itemKey);
      if (!item || claimed.has(itemKey)) continue;
      claimed.add(itemKey);
      itemKeys.push(itemKey);
      groupItems.push(item);
    }
    resolved.push({
      key: group.key,
      itemKeys,
      items: groupItems,
      ...(group.align ? { align: group.align } : {}),
      implicit: false,
    });
  }

  const residual = contentItems.filter((item) => !claimed.has(item.key));
  if (residual.length > 0) {
    let key = DEFAULT_MANAGED_TEXT_GROUP_KEY;
    let suffix = 2;
    while (usedGroupKeys.has(key)) {
      key = `${DEFAULT_MANAGED_TEXT_GROUP_KEY}-${suffix}`;
      suffix += 1;
    }
    resolved.push({
      key,
      itemKeys: residual.map((item) => item.key),
      items: residual,
      implicit: false,
    });
  }
  return [...resolved, ...chromeGroups];
}

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
  /** Preserves claiming-frame chrome when a template leaves its specialised layout. */
  reserveLegacyFrameIcon?: boolean;
  /** Mounted embedded keys that must not re-enter through the legacy text-map fallback. */
  excludedKeys?: readonly string[];
}

export interface ManagedTextModel {
  ownership: "authored" | "managed";
  items: SceneManagedTextItem[];
  /** Keys of the host chrome this model appended: the only items writers drop, whatever an item is named. */
  chromeKeys: readonly string[];
  textStyle?: Record<string, string | number>;
  textAnimationOverrides?: Record<string, TextAnimationSpec>;
}

export type ManagedTextRenderRole = "scene" | "embedded" | "managed";

export function frameIconRenderRole(
  doc: SceneDoc | null | undefined,
  claimed: boolean,
): ManagedTextRenderRole {
  if (!claimed) return "embedded";
  return managedTextOwnsScene(doc) && !isTemplateManagedText(doc) ? "managed" : "scene";
}

export function managedTextOwnsScene(doc: SceneDoc | null | undefined): boolean {
  return doc?.managedText !== undefined;
}

export function isTemplateManagedText(doc: SceneDoc | null | undefined): boolean {
  return doc?.managedText?.layout === "template";
}

export function usesSpecialisedTextRenderer(doc: SceneDoc | null | undefined): boolean {
  return !managedTextOwnsScene(doc) || isTemplateManagedText(doc);
}

/** Leaves inspector ownership intact while switching a scaffold to the generic managed stack. */
export function clearTemplateManagedTextLayout(
  doc: SceneDoc,
  options: Pick<VirtualManagedTextOptions, "icon" | "reserveLegacyFrameIcon"> = {},
): SceneDoc {
  if (!isTemplateManagedText(doc) || !doc.managedText) return doc;
  const { layout: _layout, ...managedText } = doc.managedText;
  if (!options.reserveLegacyFrameIcon || options.icon === undefined) {
    return { ...doc, managedText };
  }

  const next = materialiseManagedFrameIcon(doc, options.icon);
  if (!next.managedText) return { ...doc, managedText };
  const { layout: _nextLayout, ...genericManagedText } = next.managedText;
  return { ...next, managedText: genericManagedText };
}

function migrateLegacyFrameIcon(doc: SceneDoc): SceneDoc {
  const next = structuredClone(doc);
  if (!next.managedText) return next;
  next.managedText.items = next.managedText.items.map((item) =>
    item.key === "icon" ? { ...item, key: MANAGED_TEXT_FRAME_ICON_KEY } : item,
  );
  if (next.managedText.groups) {
    next.managedText.groups = next.managedText.groups.map((group) => ({
      ...group,
      itemKeys: group.itemKeys.filter((key) => key !== "icon"),
    }));
  }
  if (doc.textStyle) {
    const textStyle = { ...doc.textStyle };
    for (const suffix of MANAGED_TEXT_STYLE_SUFFIXES) {
      const sourceKey = `icon${suffix}`;
      const targetKey = `${MANAGED_TEXT_FRAME_ICON_KEY}${suffix}`;
      if (textStyle[sourceKey] === undefined) continue;
      if (textStyle[targetKey] === undefined) textStyle[targetKey] = textStyle[sourceKey];
      delete textStyle[sourceKey];
    }
    next.textStyle = textStyle;
  }
  if (doc.textAnimationOverrides?.icon !== undefined) {
    const textAnimationOverrides = { ...doc.textAnimationOverrides };
    if (textAnimationOverrides.frameIcon === undefined) {
      textAnimationOverrides.frameIcon = textAnimationOverrides.icon;
    }
    delete textAnimationOverrides.icon;
    next.textAnimationOverrides = textAnimationOverrides;
  }
  return next;
}

/** True when a template item has an explicit scene or item motion contract. */
export function templateManagedTextHasExplicitMotion(
  doc: SceneDoc | null | undefined,
  key: string,
): boolean {
  return (
    isTemplateManagedText(doc) &&
    (doc?.textAnimation !== undefined ||
      doc?.textAnimationForce === true ||
      doc?.textAnimationOverrides?.[key] !== undefined)
  );
}

/** True when a template item should bypass coded motion for an inspector-selected path. */
export function templateManagedTextOverridesCodedMotion(
  doc: SceneDoc | null | undefined,
  key: string,
): boolean {
  return (
    isTemplateManagedText(doc) &&
    (doc?.textAnimationForce === true || doc?.textAnimationOverrides?.[key] !== undefined)
  );
}

function managedItem(
  doc: SceneDoc | null | undefined,
  key: string,
): SceneManagedTextItem | undefined {
  return doc?.managedText?.items.find((item) => item.key === key);
}

function templateItem(
  doc: SceneDoc | null | undefined,
  key: string,
): SceneManagedTextItem | undefined {
  if (!isTemplateManagedText(doc)) return undefined;
  return managedItem(doc, key);
}

export function hasTemplateManagedTextItem(doc: SceneDoc | null | undefined, key: string): boolean {
  return templateItem(doc, key) !== undefined;
}

function splitTemplateBullets(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Resolves a template slot's inspector-owned copy, falling through untouched for every other document. */
export function resolveTemplateManagedTextCopy(
  doc: SceneDoc | null | undefined,
  key: string,
  fallback = "",
): string {
  if (!isTemplateManagedText(doc)) return fallback;
  const item = templateItem(doc, key);
  if (!item) return "";
  if (item.type === "bullets") return resolveTemplateManagedTextBullets(doc, key).join("\n");
  return item.text ?? "";
}

/** Copy for layout reservations owned by a specialised renderer, blank under the generic stack. */
export function resolveSpecialisedTextCopy(
  doc: SceneDoc | null | undefined,
  key: string,
  fallback = "",
): string {
  return usesSpecialisedTextRenderer(doc) ? resolveTemplateManagedTextCopy(doc, key, fallback) : "";
}

/** Resolves a template icon slot; a missing item deliberately removes the authored fallback. */
export function resolveTemplateManagedTextIcon(
  doc: SceneDoc | null | undefined,
  key: string,
  fallback?: string,
): string | undefined {
  if (!isTemplateManagedText(doc)) return fallback;
  const item = templateItem(doc, key);
  return item?.type === "icon" ? (item.icon ?? item.text ?? "") : undefined;
}

/** Identifies dedicated chrome or a matching legacy template alias. */
export function managedFrameIconItemKey(
  doc: SceneDoc | null | undefined,
  resolvedFrameIcon?: string,
): "frameIcon" | "icon" | undefined {
  if (managedItem(doc, MANAGED_TEXT_FRAME_ICON_KEY)) return MANAGED_TEXT_FRAME_ICON_KEY;
  if (!isTemplateManagedText(doc) || resolvedFrameIcon === undefined) return undefined;
  const item = managedItem(doc, "icon");
  return item?.type === "icon" && (item.icon ?? item.text ?? "") === resolvedFrameIcon
    ? "icon"
    : undefined;
}

/** Materialises stable frame chrome while retaining a distinct template content icon. */
export function materialiseManagedFrameIcon(doc: SceneDoc, resolvedFrameIcon: string): SceneDoc {
  if (!doc.managedText) return doc;
  const itemKey = managedFrameIconItemKey(doc, resolvedFrameIcon);
  if (itemKey === MANAGED_TEXT_FRAME_ICON_KEY) return doc;
  if (itemKey === "icon") return migrateLegacyFrameIcon(doc);
  const next = structuredClone(doc);
  next.managedText?.items.unshift({
    key: MANAGED_TEXT_FRAME_ICON_KEY,
    type: "icon",
    icon: resolvedFrameIcon,
  });
  return next;
}

/** Resolves panel chrome outside Content groups, including after a template becomes generic. */
export function resolveTemplateManagedFrameIcon(
  doc: SceneDoc | null | undefined,
  fallback?: string,
): string | undefined {
  if (!managedTextOwnsScene(doc)) return fallback;
  const itemKey = managedFrameIconItemKey(doc, fallback);
  if (!itemKey) return isTemplateManagedText(doc) ? fallback : undefined;
  const item = managedItem(doc, itemKey);
  return item?.type === "icon" ? (item.icon ?? item.text ?? "") : undefined;
}

/** Stable key for frame-icon style writes, with exact legacy fallback until the new key is used. */
export function frameIconStyleKey(doc: SceneDoc | null | undefined): "frameIcon" | "icon" {
  return managedItem(doc, MANAGED_TEXT_FRAME_ICON_KEY) ||
    Object.keys(doc?.textStyle ?? {}).some((key) => key.startsWith("frameIcon"))
    ? "frameIcon"
    : "icon";
}

/** Stable key for frame-icon motion writes, with exact legacy fallback until the new key is used. */
export function frameIconMotionKey(doc: SceneDoc | null | undefined): "frameIcon" | "icon" {
  return managedItem(doc, MANAGED_TEXT_FRAME_ICON_KEY) ||
    doc?.textAnimationOverrides?.frameIcon !== undefined
    ? "frameIcon"
    : "icon";
}

export type SpecialisedClaimedTextMode = "all" | "icon-only" | "none";

/** New dual-icon scaffolds retain their scene mark while the claiming panel owns the copy. */
export function specialisedClaimedTextMode(
  doc: SceneDoc | null | undefined,
  claimed: boolean,
): SpecialisedClaimedTextMode {
  if (!claimed) return "all";
  return isTemplateManagedText(doc) && hasTemplateManagedTextItem(doc, "frameIcon")
    ? "icon-only"
    : "none";
}

/** BrandLockup keeps its legacy full render unless a dual-icon template delegates copy to the panel. */
export function specialisedBrandLockupMode(
  doc: SceneDoc | null | undefined,
  claimed: boolean,
): SpecialisedClaimedTextMode {
  return specialisedClaimedTextMode(doc, claimed) === "icon-only" ? "icon-only" : "all";
}

/** Resolves template bullet points into the specialised renderer's legacy line model. */
export function resolveTemplateManagedTextBullets(
  doc: SceneDoc | null | undefined,
  key: string,
  fallback?: string,
): string[] {
  if (!isTemplateManagedText(doc)) return splitTemplateBullets(fallback);
  const item = templateItem(doc, key);
  if (!item) return [];
  if (item.points !== undefined) {
    return item.points.map((point) => point.text.trim()).filter(Boolean);
  }
  return splitTemplateBullets(item.text);
}

/** Code-owned scene text stands down on generic takeover; template layouts retain their composition. */
export function shouldRenderManagedTextRole(
  doc: SceneDoc | null | undefined,
  role: ManagedTextRenderRole,
): boolean {
  return usesSpecialisedTextRenderer(doc) || role !== "scene";
}

export function shouldRenderManagedTextHeadline(
  doc: SceneDoc | null | undefined,
  role: ManagedTextRenderRole,
  claimed: boolean,
): boolean {
  return shouldRenderManagedTextRole(doc, role) && !(claimed && role === "scene");
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

function captureVirtualMetadata(
  registration: VirtualManagedTextRegistration,
  textStyle: Record<string, string | number>,
  textAnimationOverrides: Record<string, TextAnimationSpec>,
): void {
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

/** Host chrome the document itself contributes, appended to every ownership branch so a takeover cannot lose the rows. Keys already carried by the block win. */
function chromeItemsFor(doc: SceneDoc, used: Iterable<string>): SceneManagedTextItem[] {
  const taken = new Set(used);
  return compareChipTextItems(doc).filter((item) => !taken.has(item.key));
}

/** Derives the pre-takeover list without writing. Existing managed blocks always win, including present-empty. */
export function deriveManagedTextModel(
  doc: SceneDoc,
  registrations: readonly VirtualManagedTextRegistration[] = [],
  options: VirtualManagedTextOptions = {},
): ManagedTextModel {
  if (doc.managedText !== undefined) {
    const blockKeys = doc.managedText.items.map((item) => item.key);
    const chrome = chromeItemsFor(doc, blockKeys);
    const managedItems =
      chrome.length > 0 ? [...doc.managedText.items, ...chrome] : doc.managedText.items;
    const chromeKeys = chrome.map((item) => item.key);
    if (!isTemplateManagedText(doc)) {
      return { ownership: "managed", items: managedItems, chromeKeys };
    }
    const keys = new Set(blockKeys);
    const textStyle: Record<string, string | number> = {};
    const textAnimationOverrides: Record<string, TextAnimationSpec> = {};
    for (const registration of registrations) {
      if (!keys.has(registration.key)) continue;
      captureVirtualMetadata(registration, textStyle, textAnimationOverrides);
    }
    return {
      ownership: "managed",
      items: managedItems,
      chromeKeys,
      ...(Object.keys(textStyle).length > 0 ? { textStyle } : {}),
      ...(Object.keys(textAnimationOverrides).length > 0 ? { textAnimationOverrides } : {}),
    };
  }
  const items: SceneManagedTextItem[] = [];
  const chromeKeys: string[] = [];
  const textStyle: Record<string, string | number> = {};
  const textAnimationOverrides: Record<string, TextAnimationSpec> = {};
  const used = new Set<string>();
  const excluded = new Set(options.excludedKeys ?? []);
  if (options.icon !== undefined) {
    const key = unusedKey(options.iconKey ?? "icon", used);
    used.add(key);
    items.push({ key, type: "icon", icon: options.icon });
  }
  if (doc.headerIcon) {
    const key = unusedKey("icon", used);
    used.add(key);
    items.push({ key, type: "icon", icon: doc.headerIcon });
  }
  for (const registration of registrations) {
    if (!registration.key.trim() || used.has(registration.key)) continue;
    const ownsCopy = Object.hasOwn(doc.text ?? {}, registration.key);
    const text = doc.text?.[registration.key] ?? registration.text;
    const phantom =
      !ownsCopy &&
      !text.trim() &&
      !registration.icon?.trim() &&
      (registration.points?.length ?? 0) === 0;
    if (phantom) continue;
    used.add(registration.key);
    items.push(
      virtualItem({
        ...registration,
        text,
      }),
    );
    captureVirtualMetadata(registration, textStyle, textAnimationOverrides);
  }
  for (const item of chromeItemsFor(doc, used)) {
    used.add(item.key);
    chromeKeys.push(item.key);
    items.push(item);
  }
  for (const [key, text] of Object.entries(doc.text ?? {})) {
    // Chip copy is chrome or nothing: CompareChips mounts on every scene, so the legacy fallback already never surfaced these keys.
    if (used.has(key) || excluded.has(key) || isCompareChipTextKey(key)) continue;
    used.add(key);
    items.push(virtualItem({ key, text }));
  }
  return {
    ownership: "authored",
    items,
    chromeKeys,
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

/** The model's own items: only the chrome the model appended is editable without belonging to the block the stack renders, so a hand-authored item sharing a chip key stays owned. */
export function ownedManagedTextItems(
  items: readonly SceneManagedTextItem[],
  chromeKeys: readonly string[],
): SceneManagedTextItem[] {
  const chrome = new Set(chromeKeys);
  return items.filter((item) => !chrome.has(item.key));
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
    managedText: { items: ownedManagedTextItems(model.items, model.chromeKeys).map(cloneItem) },
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
  /** Size passed to the renderer before its keyed Size multiplier. */
  size: number;
  /** Actual size used by layout after the keyed Size multiplier. */
  layoutSize: number;
  height: number;
  points: { point: SceneManagedTextPoint; height: number }[];
  pointGap: number;
}

function positiveStyleNumber(
  doc: SceneDoc,
  itemKey: string,
  suffix: "Size" | "LineHeight",
): number | undefined {
  const value = doc.textStyle?.[`${itemKey}${suffix}`];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
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
  if (isTemplateManagedText(doc)) return { ownsSceneText: true, nodes: [], fit: 1 };
  const defaultAlign = suppliedRegion?.align ?? doc.textLayout?.align ?? "center";
  const region = suppliedRegion ?? safeRegion(format, defaultAlign);
  const height = Math.max(0, region.top - region.bottom);
  const titleCap = format.aspect < 1 ? 0.34 : 0.56;
  const baseTitle = Math.max(0.01, Math.min(titleCap, region.width * 0.18, height * 0.14));
  const gap = baseTitle * 0.34;
  const measureItems = (items: readonly SceneManagedTextItem[]): ItemMeasure[] =>
    items.flatMap((item) => {
      const baseSize =
        item.type === "title"
          ? baseTitle
          : item.type === "icon"
            ? baseTitle * 1.15
            : baseTitle / Math.max(1, themeScale) ** 4;
      const sizeMultiplier = positiveStyleNumber(doc, item.key, "Size") ?? 1;
      const layoutSize = baseSize * sizeMultiplier;
      const lineHeight =
        positiveStyleNumber(doc, item.key, "LineHeight") ??
        (item.type === "title" ? 1.18 : item.type === "icon" ? 1.15 : 1.28);
      const pointGap = item.pointGap ?? layoutSize * 0.35;
      if (item.type === "bullets") {
        const points = managedTextPoints(item)
          .filter((point) => point.text.trim().length > 0)
          .map((point) => ({
            point,
            height: lineCount(point.text, layoutSize, region.width) * layoutSize * lineHeight,
          }));
        if (points.length === 0) return [];
        return [
          {
            item,
            size: baseSize,
            layoutSize,
            points,
            pointGap,
            height:
              points.reduce((sum, value) => sum + value.height, 0) +
              Math.max(0, points.length - 1) * pointGap,
          },
        ];
      }
      const content = item.type === "icon" ? (item.icon ?? item.text ?? "") : (item.text ?? "");
      if (!content.trim()) return [];
      return [
        {
          item,
          size: baseSize,
          layoutSize,
          points: [],
          pointGap,
          height:
            item.type === "icon"
              ? layoutSize * lineHeight
              : lineCount(content, layoutSize, region.width) * layoutSize * lineHeight,
        },
      ];
    });
  const measuredGroups = resolveManagedTextGroups(doc.managedText.items, doc.managedText.groups, [])
    .map((group) => ({ group, measures: measureItems(group.items) }))
    .filter(({ measures }) => measures.length > 0);
  const groupGap = gap * 1.75;
  const nominalHeight =
    measuredGroups.reduce(
      (sum, { measures }) =>
        sum +
        measures.reduce((groupSum, measure) => groupSum + measure.height, 0) +
        Math.max(0, measures.length - 1) * gap,
      0,
    ) +
    Math.max(0, measuredGroups.length - 1) * groupGap;
  const fit = nominalHeight > 0 ? Math.min(1, height / nominalHeight) : 1;
  const stackHeight = nominalHeight * fit;
  let cursor = region.top - Math.max(0, (height - stackHeight) / 2);
  const nodes: ManagedTextRenderNode[] = [];
  let deliveryLineIndex = 0;
  for (let groupIndex = 0; groupIndex < measuredGroups.length; groupIndex++) {
    const measuredGroup = measuredGroups[groupIndex];
    if (!measuredGroup) continue;
    const { group, measures } = measuredGroup;
    const align: SceneTextAlign = group.align ?? defaultAlign;
    const x =
      align === "left"
        ? region.left
        : align === "right"
          ? region.left + region.width
          : region.left + region.width / 2;
    for (let measureIndex = 0; measureIndex < measures.length; measureIndex++) {
      const measure = measures[measureIndex];
      if (!measure) continue;
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
            anchorX: align,
            face: "headline",
            from,
            to,
          });
        }
      } else if (item.type === "bullets") {
        let pointTop = cursor;
        const fittedLayoutSize = measure.layoutSize * fit;
        const indent = (item.indent ?? measure.layoutSize * 1.35) * fit;
        for (let pointIndex = 0; pointIndex < measure.points.length; pointIndex++) {
          const entry = measure.points[pointIndex];
          const point = entry?.point;
          if (!point) continue;
          const marker = markerText(item.marker, pointIndex);
          const pointFrom = from + pointIndex * lineStagger;
          const pointTo = to + pointIndex * lineStagger;
          const longestLine = Math.max(...point.text.split("\n").map((line) => line.length), 1);
          const textWidth = Math.min(
            Math.max(0, region.width - (marker ? indent : 0)),
            longestLine * fittedLayoutSize * 0.56,
          );
          const markerWidth = marker ? fittedLayoutSize * 0.9 : 0;
          const totalWidth = (marker ? indent : 0) + textWidth;
          const alignedStart =
            align === "left"
              ? region.left
              : align === "right"
                ? region.left + region.width - totalWidth
                : region.left + (region.width - totalWidth) / 2;
          const bulletX = group.implicit ? region.left : alignedStart;
          if (marker) {
            nodes.push({
              key: `${item.key}:${point.key}:marker`,
              itemKey: item.key,
              kind: "bullet-marker",
              text: marker,
              position: [bulletX, pointTop, 0],
              fontSize: size,
              maxWidth: group.implicit ? indent : markerWidth,
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
              maxWidth: group.implicit
                ? region.width - (marker ? indent : 0)
                : Math.max(textWidth, fittedLayoutSize * 0.56),
              anchorX: "left",
              face: "body",
              from: pointFrom,
              to: pointTo,
            });
          }
          pointTop -= (entry?.height ?? 0) * fit + measure.pointGap * fit;
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
            anchorX: align,
            face: item.type === "title" ? "headline" : "body",
            from,
            to,
          });
        }
      }
      cursor -= measure.height * fit;
      if (measureIndex < measures.length - 1) cursor -= gap * fit;
      deliveryLineIndex += item.type === "bullets" ? measure.points.length : 1;
    }
    if (groupIndex < measuredGroups.length - 1) cursor -= groupGap * fit;
  }
  return { ownsSceneText: true, nodes, fit };
}
