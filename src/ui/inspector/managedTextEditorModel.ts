import { frameTextAlign } from "../../engine/framePanelLayout";
import {
  clearTemplateManagedTextLayout,
  DEFAULT_MANAGED_TEXT_GROUP_KEY,
  deriveManagedTextModel,
  MANAGED_TEXT_FRAME_ICON_KEY,
  managedTextPoints,
  materialiseManagedFrameIcon,
  materialiseManagedText,
  resolveManagedTextGroups,
  resolveTemplateManagedFrameIcon,
  type VirtualManagedTextOptions,
  type VirtualManagedTextRegistration,
} from "../../engine/managedText";
import type {
  SceneDoc,
  SceneManagedTextGroup,
  SceneManagedTextItem,
  SceneManagedTextItemType,
  SceneManagedTextMarker,
  SceneTextAlign,
} from "../../engine/sceneDocSchema";
import type { TextAnimationSpec } from "../../theme/tokens";
import type { FrameSpec } from "../../toolkit/frame/types";

export type ManagedTextStructuralAction =
  | { type: "take-over"; itemKey?: string }
  | { type: "add-group"; afterKey?: string }
  | { type: "duplicate-group"; groupKey: string }
  | { type: "remove-group"; groupKey: string }
  | { type: "move-group"; groupKey: string; toIndex: number }
  | {
      type: "add-item";
      itemType?: SceneManagedTextItemType;
      afterKey?: string;
      groupKey?: string;
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
  selectedGroupKey: string | null;
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
  return {
    icon: frame.icon ?? "",
    iconKey: "frameIcon",
    reserveLegacyFrameIcon: true,
  };
}

function claimingTextFrame(frame: FrameSpec | undefined): boolean {
  return !!frame && frame.enabled !== false && frame.claimsSceneText !== false;
}

export function managedFrameIconValue(doc: SceneDoc, frame?: FrameSpec): string {
  if (!frame || !claimingTextFrame(frame)) return frame?.icon ?? doc.frame?.icon ?? "";
  return resolveTemplateManagedFrameIcon(doc, frame.icon) ?? "";
}

export function managedTextAlignment(doc: SceneDoc, frame?: FrameSpec): SceneTextAlign {
  if (frame && claimingTextFrame(frame)) return frameTextAlign(frame);
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
  return clearTemplateManagedTextLayout(next, {
    icon: claimingTextFrame(frame) ? (frame?.icon ?? "") : undefined,
    reserveLegacyFrameIcon: claimingTextFrame(frame),
  });
}

export function managedTextGroupAlignment(
  doc: SceneDoc,
  groupKey: string,
  fallback: SceneTextAlign = doc.textLayout?.align ?? "center",
): SceneTextAlign {
  if (!doc.managedText) return fallback;
  return (
    resolveManagedTextGroups(doc.managedText.items, doc.managedText.groups).find(
      (group) => group.key === groupKey,
    )?.align ?? fallback
  );
}

export function setManagedTextGroupAlignment(
  doc: SceneDoc,
  groupKey: string,
  align: SceneTextAlign,
  virtualOptions: VirtualManagedTextOptions = {},
): SceneDoc | null {
  if (!doc.managedText) return null;
  const resolved = resolveManagedTextGroups(doc.managedText.items, doc.managedText.groups);
  const target = resolved.find((group) => group.key === groupKey);
  if (!target || target.align === align) return null;
  const next = structuredClone(doc);
  if (!next.managedText) return null;
  next.managedText.items = cloneItems(next.managedText.items);
  next.managedText.groups = resolved.map((group) => ({
    key: group.key,
    itemKeys: [...group.itemKeys],
    ...(group.key === groupKey ? { align } : group.align ? { align: group.align } : {}),
  }));
  return clearTemplateManagedTextLayout(next, virtualOptions);
}

export function setLegacyManagedTextIcon(
  doc: SceneDoc,
  itemKey: string,
  value: string | undefined,
  frame?: FrameSpec,
): SceneDoc | null {
  if (itemKey !== "icon" && itemKey !== "frameIcon") return null;
  const nextValue = value ?? "";
  const frameTarget = itemKey === "frameIcon" && claimingTextFrame(frame);
  const current = frameTarget ? (frame?.icon ?? "") : (doc.headerIcon ?? "");
  if (current === nextValue) return null;
  const next = structuredClone(doc);
  if (frameTarget) {
    next.frame = { ...(next.frame ?? {}), icon: nextValue };
  } else if (value) {
    next.headerIcon = value;
  } else {
    delete next.headerIcon;
  }
  return next;
}

export function setManagedFrameIcon(
  doc: SceneDoc,
  value: string | undefined,
  frame?: FrameSpec,
): SceneDoc | null {
  const nextValue = value ?? "";
  if (!doc.managedText || !claimingTextFrame(frame)) {
    if ((frame?.icon ?? doc.frame?.icon ?? "") === nextValue) return null;
    const next = structuredClone(doc);
    next.frame = { ...(next.frame ?? {}), icon: nextValue };
    return next;
  }
  const resolvedFrameIcon = frame?.icon ?? "";
  if ((resolveTemplateManagedFrameIcon(doc, resolvedFrameIcon) ?? "") === nextValue) return null;
  const reserved = materialiseManagedFrameIcon(doc, resolvedFrameIcon);
  const next = reserved === doc ? structuredClone(doc) : reserved;
  if (!next.managedText) return null;
  const item = next.managedText.items.find(
    (candidate) => candidate.key === MANAGED_TEXT_FRAME_ICON_KEY,
  );
  if (item) {
    item.type = "icon";
    item.icon = nextValue;
    delete item.text;
    delete item.points;
  } else {
    next.managedText.items.unshift({
      key: MANAGED_TEXT_FRAME_ICON_KEY,
      type: "icon",
      icon: nextValue,
    });
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
    ...(item.type === "bullets"
      ? { points: managedTextPoints(item).map((point) => ({ ...point })) }
      : item.points
        ? { points: item.points.map((point) => ({ ...point })) }
        : {}),
  }));
}

function baseKey(type: SceneManagedTextItemType): string {
  return type === "bullets" ? "bullets" : type;
}

const COPY_TYPE_ORDER: readonly SceneManagedTextItemType[] = [
  "icon",
  "title",
  "subtitle",
  "bullets",
];

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
  if (type === "bullets") {
    return { key, type, points: [{ key: `${key}-point-1`, text: "Text" }] };
  }
  if (type === "icon") return { key, type, icon: "🚀" };
  return { key, type, text: "Text" };
}

function structuralHistory(action: ManagedTextStructuralAction): string {
  switch (action.type) {
    case "take-over":
      return "take over scene text";
    case "add-group":
      return "add text group";
    case "duplicate-group":
      return "duplicate text group";
    case "remove-group":
      return "remove text group";
    case "move-group":
      return "reorder text groups";
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

function cloneGroups(groups: readonly SceneManagedTextGroup[]): SceneManagedTextGroup[] {
  return groups.map((group) => ({ ...group, itemKeys: [...group.itemKeys] }));
}

function rawGroupsForItems(
  items: readonly SceneManagedTextItem[],
  groups: readonly SceneManagedTextGroup[] | undefined,
): SceneManagedTextGroup[] {
  return resolveManagedTextGroups(items, groups).map((group) => ({
    key: group.key,
    itemKeys: [...group.itemKeys],
    ...(group.align ? { align: group.align } : {}),
  }));
}

function normaliseItemsToGroupOrder(
  items: readonly SceneManagedTextItem[],
  groups: readonly SceneManagedTextGroup[],
): SceneManagedTextItem[] {
  const orderedKeys = groups.flatMap((group) => group.itemKeys);
  const groupedKeys = new Set(orderedKeys);
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  let orderedIndex = 0;
  return items.map((item) => {
    if (!groupedKeys.has(item.key)) return item;
    const orderedKey = orderedKeys[orderedIndex];
    orderedIndex += 1;
    return (orderedKey && itemByKey.get(orderedKey)) || item;
  });
}

function groupKeyForItem(
  groups: readonly SceneManagedTextGroup[],
  itemKey: string | null | undefined,
): string | null {
  if (!itemKey) return null;
  return groups.find((group) => group.itemKeys.includes(itemKey))?.key ?? null;
}

function selectedLeafForGroup(
  groups: readonly SceneManagedTextGroup[],
  groupKey: string | null,
): string | null {
  if (!groupKey) return null;
  return groups.find((group) => group.key === groupKey)?.itemKeys[0] ?? null;
}

function cloneItemForGroup(
  item: SceneManagedTextItem,
  key: string,
  items: readonly SceneManagedTextItem[],
): SceneManagedTextItem {
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
  return duplicate;
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
  const hadExplicitGroups = doc.managedText?.groups !== undefined;
  const groups = rawGroupsForItems(sourceItems, doc.managedText?.groups);
  let writeGroups = hadExplicitGroups;
  let selectedItemKey: string | null = null;
  let selectedGroupKey: string | null = null;
  const duplicateSources = new Map<string, string>();
  const removedKeys = new Set<string>();

  if (action.type === "take-over") {
    if (doc.managedText !== undefined) return null;
    selectedItemKey =
      (action.itemKey && items.some((item) => item.key === action.itemKey)
        ? action.itemKey
        : items[0]?.key) ?? null;
    selectedGroupKey = groupKeyForItem(groups, selectedItemKey) ?? groups[0]?.key ?? null;
  } else if (action.type === "add-group") {
    const emptySynthetic =
      !hadExplicitGroups &&
      groups.length === 1 &&
      groups[0]?.key === DEFAULT_MANAGED_TEXT_GROUP_KEY &&
      groups[0].itemKeys.length === 0;
    let group: SceneManagedTextGroup;
    if (emptySynthetic) {
      group = groups[0] as SceneManagedTextGroup;
    } else {
      const key = nextManagedTextKey(
        DEFAULT_MANAGED_TEXT_GROUP_KEY,
        groups.map((candidate) => candidate.key),
      );
      group = { key, itemKeys: [] };
      const afterIndex = action.afterKey
        ? groups.findIndex((candidate) => candidate.key === action.afterKey)
        : groups.length - 1;
      groups.splice(afterIndex < 0 ? groups.length : afterIndex + 1, 0, group);
    }
    const itemKey = nextManagedTextKey("title", availableItemKeys(doc, items));
    items.push(newItem("title", itemKey));
    group.itemKeys = [itemKey];
    selectedGroupKey = group.key;
    selectedItemKey = itemKey;
    writeGroups = true;
  } else if (action.type === "duplicate-group") {
    const groupIndex = groups.findIndex((group) => group.key === action.groupKey);
    const sourceGroup = groups[groupIndex];
    if (groupIndex < 0 || !sourceGroup) return null;
    const groupKey = nextManagedTextKey(
      sourceGroup.key,
      groups.map((group) => group.key),
    );
    const duplicateGroup: SceneManagedTextGroup = {
      key: groupKey,
      itemKeys: [],
      ...(sourceGroup.align ? { align: sourceGroup.align } : {}),
    };
    let insertAt = Math.max(
      0,
      ...sourceGroup.itemKeys.map((key) => items.findIndex((item) => item.key === key) + 1),
    );
    for (const sourceKey of sourceGroup.itemKeys) {
      const source = items.find((item) => item.key === sourceKey);
      if (!source) continue;
      const itemKey = nextManagedTextKey(source.key, availableItemKeys(doc, items));
      const duplicate = cloneItemForGroup(source, itemKey, items);
      items.splice(insertAt, 0, duplicate);
      insertAt += 1;
      duplicateGroup.itemKeys.push(itemKey);
      duplicateSources.set(itemKey, source.key);
    }
    groups.splice(groupIndex + 1, 0, duplicateGroup);
    selectedGroupKey = groupKey;
    selectedItemKey = duplicateGroup.itemKeys[0] ?? null;
    writeGroups = true;
  } else if (action.type === "remove-group") {
    const groupIndex = groups.findIndex((group) => group.key === action.groupKey);
    const group = groups[groupIndex];
    if (groupIndex < 0 || !group) return null;
    const keys = new Set(group.itemKeys);
    for (const key of keys) removedKeys.add(key);
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (keys.has(items[index]?.key ?? "")) items.splice(index, 1);
    }
    groups.splice(groupIndex, 1);
    selectedGroupKey = groups[groupIndex]?.key ?? groups[groupIndex - 1]?.key ?? null;
    selectedItemKey = selectedLeafForGroup(groups, selectedGroupKey);
    writeGroups = true;
  } else if (action.type === "move-group") {
    const groupIndex = groups.findIndex((group) => group.key === action.groupKey);
    const group = groups[groupIndex];
    if (groupIndex < 0 || !group) return null;
    const toIndex = Math.max(0, Math.min(groups.length - 1, action.toIndex));
    if (toIndex === groupIndex) return null;
    groups.splice(groupIndex, 1);
    groups.splice(toIndex, 0, group);
    selectedGroupKey = group.key;
    selectedItemKey = group.itemKeys[0] ?? null;
    writeGroups = true;
  } else if (action.type === "add-item") {
    const itemType = action.itemType ?? "title";
    const group = action.groupKey
      ? groups.find((candidate) => candidate.key === action.groupKey)
      : action.afterKey
        ? groups.find((candidate) => candidate.itemKeys.includes(action.afterKey as string))
        : groups[groups.length - 1];
    if (action.groupKey && !group) return null;
    const key = nextManagedTextKey(baseKey(itemType), availableItemKeys(doc, items));
    const typeIndex = COPY_TYPE_ORDER.indexOf(itemType);
    const groupIndex =
      group && action.groupKey && !action.afterKey
        ? group.itemKeys.findIndex((itemKey) => {
            const candidate = items.find((item) => item.key === itemKey);
            return candidate ? COPY_TYPE_ORDER.indexOf(candidate.type) > typeIndex : false;
          })
        : -1;
    const insertAt = action.afterKey
      ? items.findIndex((item) => item.key === action.afterKey) + 1
      : group && groupIndex >= 0
        ? items.findIndex((item) => item.key === group.itemKeys[groupIndex])
        : group
          ? Math.max(
              -1,
              ...group.itemKeys.map((itemKey) => items.findIndex((item) => item.key === itemKey)),
            ) + 1
          : items.length;
    items.splice(insertAt < 0 ? items.length : insertAt, 0, newItem(itemType, key));
    if (group) {
      if (groupIndex < 0) group.itemKeys.push(key);
      else group.itemKeys.splice(groupIndex, 0, key);
    }
    selectedItemKey = key;
    selectedGroupKey = group?.key ?? groupKeyForItem(groups, key);
    if (action.groupKey) writeGroups = true;
  } else {
    const itemIndex = items.findIndex((item) => item.key === action.itemKey);
    if (itemIndex < 0) return null;
    const item = items[itemIndex];
    if (!item) return null;
    selectedItemKey = item.key;
    selectedGroupKey = groupKeyForItem(groups, item.key);

    switch (action.type) {
      case "duplicate-item": {
        const key = nextManagedTextKey(item.key, availableItemKeys(doc, items));
        const duplicate = cloneItemForGroup(item, key, items);
        items.splice(itemIndex + 1, 0, duplicate);
        const group = groups.find((candidate) => candidate.key === selectedGroupKey);
        const groupItemIndex = group?.itemKeys.indexOf(item.key) ?? -1;
        if (group && groupItemIndex >= 0) group.itemKeys.splice(groupItemIndex + 1, 0, key);
        selectedItemKey = key;
        duplicateSources.set(key, item.key);
        break;
      }
      case "remove-item": {
        const group = groups.find((candidate) => candidate.key === selectedGroupKey);
        const groupItemIndex = group?.itemKeys.indexOf(item.key) ?? -1;
        items.splice(itemIndex, 1);
        for (const candidate of groups) {
          candidate.itemKeys = candidate.itemKeys.filter((key) => key !== item.key);
        }
        selectedItemKey =
          group && groupItemIndex >= 0
            ? (group.itemKeys[groupItemIndex] ?? group.itemKeys[groupItemIndex - 1] ?? null)
            : (items[itemIndex]?.key ?? items[itemIndex - 1]?.key ?? null);
        removedKeys.add(item.key);
        break;
      }
      case "move-item": {
        const toIndex = Math.max(0, Math.min(items.length - 1, action.toIndex));
        const targetKey = items[toIndex]?.key;
        const group = groups.find((candidate) => candidate.key === selectedGroupKey);
        const groupItemIndex = group?.itemKeys.indexOf(item.key) ?? -1;
        const groupTargetIndex = targetKey ? (group?.itemKeys.indexOf(targetKey) ?? -1) : -1;
        if (group && groupItemIndex >= 0 && groupTargetIndex >= 0) {
          if (groupTargetIndex === groupItemIndex) return null;
          group.itemKeys.splice(groupItemIndex, 1);
          group.itemKeys.splice(groupTargetIndex, 0, item.key);
          items.splice(0, items.length, ...normaliseItemsToGroupOrder(items, groups));
        } else {
          if (toIndex === itemIndex) return null;
          items.splice(itemIndex, 1);
          items.splice(toIndex, 0, item);
          for (const candidate of groups) {
            candidate.itemKeys.sort(
              (left, right) =>
                items.findIndex((value) => value.key === left) -
                items.findIndex((value) => value.key === right),
            );
          }
        }
        break;
      }
      case "change-type":
        if (item.type === action.itemType) return null;
        item.type = action.itemType;
        if (action.itemType === "icon" && item.icon === undefined) item.icon = "🚀";
        if (
          (action.itemType === "title" || action.itemType === "subtitle") &&
          item.text === undefined
        ) {
          item.text = "Text";
        }
        if (action.itemType === "bullets" && item.points === undefined) {
          item.points = [{ key: nextPointKey(item.key, items), text: "Text" }];
        }
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
  if (writeGroups) next.managedText.groups = cloneGroups(groups);
  next = clearTemplateManagedTextLayout(next, virtualOptions);
  for (const [target, source] of duplicateSources) copyItemSideTables(next, source, target);
  for (const key of removedKeys) removeItemSideTables(next, key);
  return { doc: next, selectedItemKey, selectedGroupKey };
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
    if (item?.type === "bullets" && item.points === undefined) {
      item.points = managedTextPoints(item).map((point) => ({ ...point }));
    }
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
    const nextValue = value ?? "";
    if (!item || item.icon === nextValue) return null;
    item.icon = nextValue;
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

export function setManagedTextColour(
  doc: SceneDoc,
  itemKey: string,
  value: string | undefined,
  registrations: readonly VirtualManagedTextRegistration[] = [],
  virtualOptions: VirtualManagedTextOptions = {},
): SceneDoc | null {
  const item = virtualItem(doc, itemKey, registrations, virtualOptions);
  if (!item || item.type === "icon") return null;
  const key = `${itemKey}Color`;
  const current = doc.textStyle?.[key];
  if (value === undefined ? current === undefined : current === value) return null;
  const next = structuredClone(doc);
  const textStyle = { ...next.textStyle };
  if (value === undefined) delete textStyle[key];
  else textStyle[key] = value;
  if (Object.keys(textStyle).length > 0) next.textStyle = textStyle;
  else delete next.textStyle;
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
