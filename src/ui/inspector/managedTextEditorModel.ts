import { frameTextAlign } from "../../engine/framePanelLayout";
import {
  deriveManagedTextModel,
  materialiseManagedText,
  type VirtualManagedTextOptions,
  type VirtualManagedTextRegistration,
} from "../../engine/managedText";
import type {
  SceneDoc,
  SceneManagedTextItem,
  SceneManagedTextItemType,
  SceneManagedTextMarker,
  SceneTextAlign,
} from "../../engine/sceneDocSchema";
import type { TextAnimationSpec } from "../../theme/tokens";
import type { FrameSpec } from "../../toolkit/frame/types";

export type ManagedTextStructuralAction =
  | { type: "take-over"; itemKey?: string }
  | {
      type: "add-item";
      itemType?: SceneManagedTextItemType;
      afterKey?: string;
    }
  | { type: "duplicate-item"; itemKey: string }
  | { type: "remove-item"; itemKey: string }
  | { type: "move-item"; itemKey: string; toIndex: number }
  | { type: "change-type"; itemKey: string; itemType: SceneManagedTextItemType }
  | {
      type: "add-point";
      itemKey: string;
      afterPointKey?: string;
      afterPointText?: string;
      text?: string;
    }
  | { type: "remove-point"; itemKey: string; pointKey: string }
  | { type: "move-point"; itemKey: string; pointKey: string; toIndex: number }
  | { type: "set-marker"; itemKey: string; marker: SceneManagedTextMarker }
  | { type: "set-point-gap"; itemKey: string; pointGap: number }
  | { type: "set-indent"; itemKey: string; indent: number };

export interface ManagedTextStructuralResult {
  doc: SceneDoc;
  selectedItemKey: string | null;
}

export interface ManagedTextTakeoverRequest {
  action: ManagedTextStructuralAction;
  itemCount: number;
}

export type ConfirmManagedTextTakeover = (request: ManagedTextTakeoverRequest) => Promise<boolean>;

export interface PerformManagedTextStructuralActionOptions {
  doc: SceneDoc;
  registrations?: readonly VirtualManagedTextRegistration[];
  virtualOptions?: VirtualManagedTextOptions;
  action: ManagedTextStructuralAction;
  confirmTakeover?: ConfirmManagedTextTakeover;
  commit: (result: ManagedTextStructuralResult, history: string) => Promise<void> | void;
}

export type ManagedTextStructuralStatus = "committed" | "cancelled" | "noop";

export function managedTextVirtualOptionsForFrame(
  frame: FrameSpec | undefined,
): VirtualManagedTextOptions {
  if (!frame || frame.enabled === false || frame.claimsSceneText === false) return {};
  return { icon: frame.icon ?? "", iconKey: "icon" };
}

function claimingTextFrame(frame: FrameSpec | undefined): frame is FrameSpec {
  return !!frame && frame.enabled !== false && frame.claimsSceneText !== false;
}

export function managedTextAlignment(doc: SceneDoc, frame?: FrameSpec): SceneTextAlign {
  if (claimingTextFrame(frame)) return frameTextAlign(frame);
  return doc.textLayout?.align ?? "center";
}

export function setManagedTextAlignment(
  doc: SceneDoc,
  align: SceneTextAlign,
  frame?: FrameSpec,
): SceneDoc | null {
  if (managedTextAlignment(doc, frame) === align) return null;
  const next = structuredClone(doc);
  if (claimingTextFrame(frame)) {
    next.frame = { ...(next.frame ?? {}), textAlign: align };
  } else {
    next.textLayout = { ...(next.textLayout ?? {}), align };
  }
  return next;
}

export function setLegacyManagedTextIcon(
  doc: SceneDoc,
  itemKey: string,
  value: string | undefined,
  frame?: FrameSpec,
): SceneDoc | null {
  if (itemKey !== "icon") return null;
  const nextValue = value ?? "";
  const current = claimingTextFrame(frame) ? (frame.icon ?? "") : (doc.headerIcon ?? "");
  if (current === nextValue) return null;
  const next = structuredClone(doc);
  if (claimingTextFrame(frame)) {
    next.frame = { ...(next.frame ?? {}), icon: nextValue };
  } else if (value) {
    next.headerIcon = value;
  } else {
    delete next.headerIcon;
  }
  return next;
}

const STYLE_SUFFIXES = [
  "Color",
  "Font",
  "Size",
  "OffsetX",
  "OffsetY",
  "LineHeight",
  "RotationDeg",
] as const;

export type ManagedTextStyleField = "size" | "x" | "y" | "rotation" | "spacing";

const STYLE_FIELD_SUFFIX: Record<ManagedTextStyleField, (typeof STYLE_SUFFIXES)[number]> = {
  size: "Size",
  x: "OffsetX",
  y: "OffsetY",
  rotation: "RotationDeg",
  spacing: "LineHeight",
};

export type TextMotionScope = { kind: "all" } | { kind: "item"; itemKey: string };

function cloneItems(items: readonly SceneManagedTextItem[]): SceneManagedTextItem[] {
  return items.map((item) => ({
    ...item,
    ...(item.points ? { points: item.points.map((point) => ({ ...point })) } : {}),
  }));
}

function baseKey(type: SceneManagedTextItemType): string {
  return type === "bullets" ? "bullets" : type;
}

export function nextManagedTextKey(preferred: string, used: Iterable<string>): string {
  const taken = new Set(used);
  if (!taken.has(preferred)) return preferred;
  let suffix = 2;
  while (taken.has(`${preferred}-${suffix}`)) suffix += 1;
  return `${preferred}-${suffix}`;
}

function nextPointKey(itemKey: string, items: readonly SceneManagedTextItem[]): string {
  const used = new Set(items.flatMap((item) => item.points?.map((point) => point.key) ?? []));
  let index = 1;
  while (used.has(`${itemKey}-point-${index}`)) index += 1;
  return `${itemKey}-point-${index}`;
}

function newItem(type: SceneManagedTextItemType, key: string): SceneManagedTextItem {
  if (type === "bullets") return { key, type, text: "", points: [] };
  if (type === "icon") return { key, type, text: "", icon: "" };
  return { key, type, text: "" };
}

function structuralHistory(action: ManagedTextStructuralAction): string {
  switch (action.type) {
    case "take-over":
      return "take over scene text";
    case "add-item":
      return "add text line";
    case "duplicate-item":
      return "duplicate text line";
    case "remove-item":
      return "remove text line";
    case "move-item":
      return "reorder text lines";
    case "change-type":
      return "change text line type";
    case "add-point":
      return "add bullet point";
    case "remove-point":
      return "remove bullet point";
    case "move-point":
      return "reorder bullet points";
    case "set-marker":
      return "change bullet marker";
    case "set-point-gap":
      return "change bullet point gap";
    case "set-indent":
      return "change bullet indent";
  }
}

function copyItemSideTables(doc: SceneDoc, sourceKey: string, targetKey: string): void {
  if (doc.textStyle) {
    const textStyle = { ...doc.textStyle };
    for (const suffix of STYLE_SUFFIXES) {
      const value = doc.textStyle[`${sourceKey}${suffix}`];
      if (value !== undefined) textStyle[`${targetKey}${suffix}`] = value;
    }
    doc.textStyle = textStyle;
  }
  const motion = doc.textAnimationOverrides?.[sourceKey];
  if (motion) {
    doc.textAnimationOverrides = {
      ...doc.textAnimationOverrides,
      [targetKey]: structuredClone(motion),
    };
  }
}

function removeItemSideTables(doc: SceneDoc, itemKey: string): void {
  if (doc.textStyle) {
    const textStyle = { ...doc.textStyle };
    for (const suffix of STYLE_SUFFIXES) delete textStyle[`${itemKey}${suffix}`];
    if (Object.keys(textStyle).length > 0) doc.textStyle = textStyle;
    else delete doc.textStyle;
  }
  if (doc.textAnimationOverrides?.[itemKey]) {
    const overrides = { ...doc.textAnimationOverrides };
    delete overrides[itemKey];
    if (Object.keys(overrides).length > 0) doc.textAnimationOverrides = overrides;
    else delete doc.textAnimationOverrides;
  }
}

function availableItemKeys(doc: SceneDoc, items: readonly SceneManagedTextItem[]): Set<string> {
  return new Set([
    ...items.map((item) => item.key),
    ...Object.keys(doc.text ?? {}),
    ...Object.keys(doc.textAnimationOverrides ?? {}),
  ]);
}

/** Applies one stable-key structural action. An absent block is materialised in the returned document only. */
export function applyManagedTextStructuralAction(
  doc: SceneDoc,
  action: ManagedTextStructuralAction,
  registrations: readonly VirtualManagedTextRegistration[] = [],
  virtualOptions: VirtualManagedTextOptions = {},
): ManagedTextStructuralResult | null {
  const model = deriveManagedTextModel(doc, registrations, virtualOptions);
  const sourceItems = cloneItems(model.items);
  const items = cloneItems(sourceItems);
  let selectedItemKey: string | null = null;
  let duplicateSource: string | null = null;
  let removedKey: string | null = null;

  if (action.type === "take-over") {
    if (doc.managedText !== undefined) return null;
    selectedItemKey =
      (action.itemKey && items.some((item) => item.key === action.itemKey)
        ? action.itemKey
        : items[0]?.key) ?? null;
  } else if (action.type === "add-item") {
    const itemType = action.itemType ?? "title";
    const key = nextManagedTextKey(baseKey(itemType), availableItemKeys(doc, items));
    const insertAfter = action.afterKey
      ? items.findIndex((item) => item.key === action.afterKey)
      : items.length - 1;
    const insertAt = insertAfter < 0 ? items.length : insertAfter + 1;
    items.splice(insertAt, 0, newItem(itemType, key));
    selectedItemKey = key;
  } else {
    const itemIndex = items.findIndex((item) => item.key === action.itemKey);
    if (itemIndex < 0) return null;
    const item = items[itemIndex];
    if (!item) return null;
    selectedItemKey = item.key;

    switch (action.type) {
      case "duplicate-item": {
        const key = nextManagedTextKey(item.key, availableItemKeys(doc, items));
        const duplicate = structuredClone(item);
        duplicate.key = key;
        if (duplicate.points) {
          const usedPointKeys = new Set(
            items.flatMap((candidate) => candidate.points?.map((point) => point.key) ?? []),
          );
          duplicate.points = duplicate.points.map((point, index) => {
            const pointKey = nextManagedTextKey(`${key}-point-${index + 1}`, usedPointKeys);
            usedPointKeys.add(pointKey);
            return { ...point, key: pointKey };
          });
        }
        items.splice(itemIndex + 1, 0, duplicate);
        selectedItemKey = key;
        duplicateSource = item.key;
        break;
      }
      case "remove-item":
        items.splice(itemIndex, 1);
        selectedItemKey = items[itemIndex]?.key ?? items[itemIndex - 1]?.key ?? null;
        removedKey = item.key;
        break;
      case "move-item": {
        const toIndex = Math.max(0, Math.min(items.length - 1, action.toIndex));
        if (toIndex === itemIndex) return null;
        items.splice(itemIndex, 1);
        items.splice(toIndex, 0, item);
        break;
      }
      case "change-type":
        if (item.type === action.itemType) return null;
        item.type = action.itemType;
        break;
      case "add-point": {
        const points = [...(item.points ?? [])];
        const key = nextPointKey(item.key, items);
        const afterIndex = action.afterPointKey
          ? points.findIndex((point) => point.key === action.afterPointKey)
          : points.length - 1;
        if (afterIndex >= 0 && action.afterPointText !== undefined) {
          const point = points[afterIndex];
          if (point) points[afterIndex] = { ...point, text: action.afterPointText };
        }
        const insertAt = afterIndex < 0 ? points.length : afterIndex + 1;
        points.splice(insertAt, 0, { key, text: action.text ?? "" });
        item.points = points;
        break;
      }
      case "remove-point": {
        const points = item.points ?? [];
        const pointIndex = points.findIndex((point) => point.key === action.pointKey);
        if (pointIndex < 0) return null;
        item.points = points.filter((point) => point.key !== action.pointKey);
        break;
      }
      case "move-point": {
        const points = [...(item.points ?? [])];
        const pointIndex = points.findIndex((point) => point.key === action.pointKey);
        if (pointIndex < 0) return null;
        const toIndex = Math.max(0, Math.min(points.length - 1, action.toIndex));
        if (toIndex === pointIndex) return null;
        const point = points[pointIndex];
        if (!point) return null;
        points.splice(pointIndex, 1);
        points.splice(toIndex, 0, point);
        item.points = points;
        break;
      }
      case "set-marker":
        if (item.marker === action.marker) return null;
        item.marker = action.marker;
        break;
      case "set-point-gap":
        if (item.pointGap === action.pointGap) return null;
        item.pointGap = action.pointGap;
        break;
      case "set-indent":
        if (item.indent === action.indent) return null;
        item.indent = action.indent;
        break;
    }
  }

  let next = materialiseManagedText(doc, { ...model, items: sourceItems });
  if (next === doc) next = structuredClone(doc);
  else next = structuredClone(next);
  if (!next.managedText) return null;
  next.managedText.items = items;
  if (duplicateSource && selectedItemKey) {
    copyItemSideTables(next, duplicateSource, selectedItemKey);
  }
  if (removedKey) removeItemSideTables(next, removedKey);
  return { doc: next, selectedItemKey };
}

/** Confirms takeover only for code-owned text, then emits exactly one committed document. */
export async function performManagedTextStructuralAction({
  doc,
  registrations = [],
  virtualOptions = {},
  action,
  confirmTakeover,
  commit,
}: PerformManagedTextStructuralActionOptions): Promise<ManagedTextStructuralStatus> {
  if (doc.managedText === undefined) {
    if (!confirmTakeover) return "cancelled";
    const accepted = await confirmTakeover({
      action,
      itemCount: deriveManagedTextModel(doc, registrations, virtualOptions).items.length,
    });
    if (!accepted) return "cancelled";
  }
  const result = applyManagedTextStructuralAction(doc, action, registrations, virtualOptions);
  if (!result) return "noop";
  await commit(result, structuralHistory(action));
  return "committed";
}

function virtualItem(
  doc: SceneDoc,
  itemKey: string,
  registrations: readonly VirtualManagedTextRegistration[],
  virtualOptions: VirtualManagedTextOptions,
): SceneManagedTextItem | undefined {
  return deriveManagedTextModel(doc, registrations, virtualOptions).items.find(
    (item) => item.key === itemKey,
  );
}

export function setManagedTextCopy(
  doc: SceneDoc,
  itemKey: string,
  value: string,
  registrations: readonly VirtualManagedTextRegistration[] = [],
  virtualOptions: VirtualManagedTextOptions = {},
): SceneDoc | null {
  const next = structuredClone(doc);
  if (next.managedText) {
    const item = next.managedText.items.find((candidate) => candidate.key === itemKey);
    if (!item || item.text === value) return null;
    item.text = value;
    return next;
  }
  const item = virtualItem(doc, itemKey, registrations, virtualOptions);
  if (!item || item.type === "icon" || doc.text?.[itemKey] === value) return null;
  next.text = { ...next.text, [itemKey]: value };
  return next;
}

export function setManagedTextPointCopy(
  doc: SceneDoc,
  itemKey: string,
  pointKey: string,
  value: string,
  registrations: readonly VirtualManagedTextRegistration[] = [],
  virtualOptions: VirtualManagedTextOptions = {},
): SceneDoc | null {
  const next = structuredClone(doc);
  if (next.managedText) {
    const item = next.managedText.items.find((candidate) => candidate.key === itemKey);
    const point = item?.points?.find((candidate) => candidate.key === pointKey);
    if (!point || point.text === value) return null;
    point.text = value;
    return next;
  }
  const item = virtualItem(doc, itemKey, registrations, virtualOptions);
  const points = item?.points?.map((point) => ({ ...point }));
  const point = points?.find((candidate) => candidate.key === pointKey);
  if (!item || !points || !point || point.text === value) return null;
  point.text = value;
  next.text = { ...next.text, [itemKey]: points.map((candidate) => candidate.text).join("\n") };
  return next;
}

export function setManagedTextIcon(
  doc: SceneDoc,
  itemKey: string,
  value: string | undefined,
  registrations: readonly VirtualManagedTextRegistration[] = [],
  virtualOptions: VirtualManagedTextOptions = {},
): SceneDoc | null {
  const next = structuredClone(doc);
  if (next.managedText) {
    const item = next.managedText.items.find((candidate) => candidate.key === itemKey);
    if (!item || item.icon === value) return null;
    if (value === undefined) delete item.icon;
    else item.icon = value;
    return next;
  }
  const item = virtualItem(doc, itemKey, registrations, virtualOptions);
  if (item?.type !== "icon") return null;
  const current = virtualOptions.icon ?? doc.headerIcon;
  if (current === value) return null;
  if (value === undefined) delete next.headerIcon;
  else next.headerIcon = value;
  return next;
}

export function managedTextStyleValue(
  doc: SceneDoc,
  itemKey: string,
  field: ManagedTextStyleField,
): number {
  const value = doc.textStyle?.[`${itemKey}${STYLE_FIELD_SUFFIX[field]}`];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (field === "size") return 1;
  if (field === "spacing") return 1.2;
  return 0;
}

export function setManagedTextStyle(
  doc: SceneDoc,
  itemKey: string,
  field: ManagedTextStyleField,
  value: number,
): SceneDoc | null {
  if (!Number.isFinite(value)) return null;
  const key = `${itemKey}${STYLE_FIELD_SUFFIX[field]}`;
  const current = managedTextStyleValue(doc, itemKey, field);
  if (current === value) return null;
  const next = structuredClone(doc);
  next.textStyle = { ...next.textStyle, [key]: value };
  return next;
}

export function textMotionSpec(
  doc: SceneDoc,
  scope: TextMotionScope,
): TextAnimationSpec | undefined {
  return scope.kind === "all" ? doc.textAnimation : doc.textAnimationOverrides?.[scope.itemKey];
}

export function setTextMotionSpec(
  doc: SceneDoc,
  scope: TextMotionScope,
  spec: TextAnimationSpec | undefined,
): SceneDoc {
  const next = structuredClone(doc);
  if (scope.kind === "all") {
    if (spec) next.textAnimation = structuredClone(spec);
    else delete next.textAnimation;
    return next;
  }
  const overrides = { ...next.textAnimationOverrides };
  if (spec) overrides[scope.itemKey] = structuredClone(spec);
  else delete overrides[scope.itemKey];
  if (Object.keys(overrides).length > 0) next.textAnimationOverrides = overrides;
  else delete next.textAnimationOverrides;
  return next;
}

/** Applies only fields changed by one motion action, preserving newer queued edits to sibling fields. */
export function rebaseTextMotionSpec(
  current: TextAnimationSpec | undefined,
  baseline: TextAnimationSpec | undefined,
  next: TextAnimationSpec | undefined,
): TextAnimationSpec | undefined {
  if (!next) return undefined;
  if (!baseline || !current) return structuredClone(next);
  const rebased = structuredClone(current) as TextAnimationSpec & Record<string, unknown>;
  const before = baseline as TextAnimationSpec & Record<string, unknown>;
  const after = next as TextAnimationSpec & Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (Object.is(before[key], after[key])) continue;
    if (key in after) rebased[key] = after[key];
    else delete rebased[key];
  }
  return rebased;
}

export function describeManagedTextMotion(spec: TextAnimationSpec | undefined): string {
  if (!spec) return "Theme";
  if (spec.in === "static") return "None";
  const label = spec.in
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return label || "Theme";
}
