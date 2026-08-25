import { useEffect, useId, useRef, useState } from "react";
import {
  deriveManagedTextModel,
  isChromeManagedTextGroup,
  resolveManagedTextGroups,
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
import { defaultTheme } from "../../theme";
import type { Theme } from "../../theme/tokens";
import { ContextMenu, type ContextMenuState } from "../ContextMenu";
import { ColourPicker } from "../colour/ColourPicker";
import { HEADER_EMOJIS } from "../SceneTextFields";
import {
  applyManagedTextStructuralAction,
  type ConfirmManagedTextTakeover,
  describeManagedTextLook,
  describeManagedTextMotion,
  type ManagedTextStructuralAction,
  managedTextGroupAlignment,
  managedTextStyleValue,
  performManagedTextStructuralAction,
  selectedManagedTextGroup,
  setManagedTextAlignment,
  setManagedTextColour,
  setManagedTextCopy,
  setManagedTextGroupAlignment,
  setManagedTextIcon,
  setManagedTextPointCopy,
  setManagedTextStyle,
} from "./managedTextEditorModel";
import {
  ActionRow,
  DrillBack,
  DrillGroup,
  DrillHeaderAction,
  InspectorSliderRow,
  NumberField,
  type SegmentedOption,
  SegmentedRow,
} from "./rows";

export interface ManagedTextWriteRequest {
  /** Deterministic preview derived from `baseline`; integrations must not persist it directly. */
  preview: SceneDoc;
  history: string | false;
  /** The document `preview` was derived from. */
  baseline: SceneDoc;
  /** True when the final write must collapse preceding history-free ticks into one undo entry. */
  historyFromBaseline?: boolean;
  /** SceneTab must run this against the queued current document before persistence. */
  applyToCurrent: (current: SceneDoc) => SceneDoc;
}

export type ManagedTextWrite = (
  request: ManagedTextWriteRequest,
) => Promise<boolean | undefined> | boolean | undefined;

export interface PointerReorderRowBounds {
  top: number;
  bottom: number;
}

export function pointerReorderIndex(
  clientY: number,
  rows: readonly PointerReorderRowBounds[],
): number | null {
  if (rows.length === 0) return null;
  let nearest = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [index, row] of rows.entries()) {
    const distance = Math.abs(clientY - (row.top + row.bottom) / 2);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export function restoreManagedTextActivatorFocus(
  ref: { current: HTMLElement | null },
  schedule: (callback: () => void) => void = (callback) => {
    window.requestAnimationFrame(callback);
  },
): void {
  const activator = ref.current;
  ref.current = null;
  if (!activator) return;
  schedule(() => {
    if (activator.isConnected) activator.focus({ preventScroll: true });
  });
}

export interface ManagedTextDrillProps {
  doc: SceneDoc;
  registrations?: readonly VirtualManagedTextRegistration[];
  virtualOptions?: VirtualManagedTextOptions;
  /** Re-resolves doc-backed overlay icons when a queued write runs against a newer document. */
  virtualOptionsForDoc?: (doc: SceneDoc) => VirtualManagedTextOptions;
  selectedGroupKey?: string | null;
  selectedItemKey?: string | null;
  backLabel?: string;
  onBack: () => void;
  onSelectGroup?: (groupKey: string | null) => void;
  onSelectItem: (itemKey: string | null) => void;
  onOpenMotion: (itemKey: string) => void;
  /** Opens the text-style (look) drill; absent hides the row. */
  onOpenLook?: (itemKey: string) => void;
  onEditFont: (itemKey: string) => void;
  theme?: Theme;
  colourDefaults?: Readonly<Record<string, string>>;
  confirmTakeover?: ConfirmManagedTextTakeover;
  writeDoc: ManagedTextWrite;
  recentIcons?: readonly string[];
  resolveIconPreview?: (value: string) => string | undefined;
  onOpenEmoji?: (itemKey: string) => Promise<string | undefined> | string | undefined;
  onChooseImage?: (itemKey: string) => Promise<string | undefined> | string | undefined;
  onIconCommitted?: (value: string) => void;
  alignment?: SceneTextAlign;
  /** Overlay integrations can replace the default `textLayout` alignment write. */
  mutateAlignment?: (doc: SceneDoc, align: SceneTextAlign) => SceneDoc | null;
  /** Overlay integrations can replace the default `headerIcon` legacy write. */
  mutateIcon?: (doc: SceneDoc, itemKey: string, value: string | undefined) => SceneDoc | null;
  notice?: string | null;
  disabled?: boolean;
}

const TYPE_OPTIONS: SegmentedOption<SceneManagedTextItemType>[] = [
  { value: "title", label: "Title", icon: <TextTypeIcon type="title" /> },
  { value: "subtitle", label: "Subtitle", icon: <TextTypeIcon type="subtitle" /> },
  { value: "bullets", label: "Bullets", icon: <TextTypeIcon type="bullets" /> },
  { value: "icon", label: "Icon", icon: <TextTypeIcon type="icon" /> },
];

const ALIGNMENT_OPTIONS: SegmentedOption<SceneTextAlign>[] = [
  { value: "left", label: "Left", icon: <TextAlignmentIcon align="left" /> },
  { value: "center", label: "Centre", icon: <TextAlignmentIcon align="center" /> },
  { value: "right", label: "Right", icon: <TextAlignmentIcon align="right" /> },
];

const MARKERS: readonly { value: SceneManagedTextMarker; label: string; preview: string }[] = [
  { value: "dot", label: "Dot", preview: "•" },
  { value: "dash", label: "Dash", preview: "–" },
  { value: "tick", label: "Tick", preview: "✓" },
  { value: "number", label: "Number", preview: "1." },
  { value: "none", label: "None", preview: "∅" },
];

interface PointerReorderDrag {
  pointerId: number;
  key: string;
  startY: number;
  targetIndex: number;
  active: boolean;
}

interface ManagedTextMenu {
  key: string;
  kind: "add" | "item";
  state: ContextMenuState;
}

const POINTER_REORDER_THRESHOLD_PX = 4;

function listRowBounds(list: HTMLOListElement | null): PointerReorderRowBounds[] {
  if (!list) return [];
  return Array.from(list.children).map((child) => {
    const rect = child.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  });
}

function TextTypeIcon({ type }: { type: SceneManagedTextItemType }) {
  const glyph =
    type === "title" ? (
      <path d="M3.2 4.2h9.6M8 4.2v8.6" />
    ) : type === "subtitle" ? (
      <path d="M5.2 6.4h5.6M8 6.4v6.2" />
    ) : type === "bullets" ? (
      <>
        <circle cx="3.2" cy="4.6" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="3.2" cy="8" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="3.2" cy="11.4" r="1.1" fill="currentColor" stroke="none" />
        <path d="M6.2 4.6h7.2M6.2 8h7.2M6.2 11.4h5" />
      </>
    ) : (
      <>
        <circle cx="8" cy="8" r="5.6" />
        <circle cx="6.1" cy="6.6" r="0.75" fill="currentColor" stroke="none" />
        <circle cx="9.9" cy="6.6" r="0.75" fill="currentColor" stroke="none" />
        <path d="M5.8 9.4a2.9 2.9 0 0 0 4.4 0" />
      </>
    );

  return (
    <svg
      data-text-type-icon={type}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}

function TextAlignmentIcon({ align }: { align: SceneTextAlign }) {
  const middleLine =
    align === "left" ? "M2.6 8h6.6" : align === "center" ? "M4.7 8h6.6" : "M6.8 8h6.6";

  return (
    <svg
      data-text-alignment-icon={align}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.6 4.4h10.8M2.6 11.6h10.8" />
      <path d={middleLine} />
    </svg>
  );
}

/** The text drill's control glyphs; `colour` is shared with the comparison drill's divider colour row, which wears the same layout. */
export function TextControlIcon({
  type,
}: {
  type: "gap" | "indent" | "motion" | "spacing" | "font" | "colour" | "look";
}) {
  const glyph =
    type === "look" ? (
      <>
        <path d="m9.5 2.5 4 4L6 14l-3.5.5L3 11z" />
        <path d="m8 4 4 4" />
      </>
    ) : type === "gap" ? (
      <>
        <path d="M3 4h10M3 12h10" />
        <path d="M8 6v4M6.5 7.5 8 6l1.5 1.5M6.5 8.5 8 10l1.5-1.5" />
      </>
    ) : type === "indent" ? (
      <>
        <path d="M6 4h7M6 8h7M6 12h7" />
        <path d="m2.5 6 2 2-2 2" />
      </>
    ) : type === "spacing" ? (
      <>
        <path d="M4 3h9M4 8h9M4 13h9" />
        <path d="M2 4.5v7M1 6l1-1.5L3 6M1 10l1 1.5L3 10" />
      </>
    ) : type === "font" ? (
      <path d="M3 5V3h10v2M8 3v10M5.5 13h5" />
    ) : type === "colour" ? (
      <path d="M8 2.5s4 4.2 4 7a4 4 0 0 1-8 0c0-2.8 4-7 4-7z" />
    ) : (
      <>
        <path d="M3 8h10" />
        <path d="m9.5 4.5 3.5 3.5-3.5 3.5" />
      </>
    );
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}

/** The All lines / This line scope glyphs; shared by the motion and style drills' segments. */
export function TextScopeIcon({ scope }: { scope: "all" | "item" }) {
  const glyph =
    scope === "all" ? (
      <path d="M3 4.5h10M3 8h10M3 11.5h10" />
    ) : (
      <>
        <path d="M3 4.5h10M3 11.5h10" opacity="0.4" />
        <path d="M3 8h10" />
      </>
    );
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}

function SmallIcon({
  type,
}: {
  type: "add" | "duplicate" | "grip" | "more" | "up" | "down" | "remove";
}) {
  const glyph =
    type === "add" ? (
      <path d="M8 3v10M3 8h10" />
    ) : type === "duplicate" ? (
      <>
        <rect x="5.5" y="5.5" width="7" height="7" rx="1" />
        <path d="M3.5 10.5h-1v-7a1 1 0 0 1 1-1h7v1" />
      </>
    ) : type === "grip" ? (
      <>
        <circle cx="5" cy="4" r="0.7" fill="currentColor" stroke="none" />
        <circle cx="11" cy="4" r="0.7" fill="currentColor" stroke="none" />
        <circle cx="5" cy="8" r="0.7" fill="currentColor" stroke="none" />
        <circle cx="11" cy="8" r="0.7" fill="currentColor" stroke="none" />
        <circle cx="5" cy="12" r="0.7" fill="currentColor" stroke="none" />
        <circle cx="11" cy="12" r="0.7" fill="currentColor" stroke="none" />
      </>
    ) : type === "more" ? (
      <>
        <circle cx="8" cy="3.5" r="1" fill="currentColor" stroke="none" />
        <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
        <circle cx="8" cy="12.5" r="1" fill="currentColor" stroke="none" />
      </>
    ) : type === "up" ? (
      <path d="m4 10 4-4 4 4" />
    ) : type === "down" ? (
      <path d="m4 6 4 4 4-4" />
    ) : (
      <>
        <path d="M3 4h10M6 4V2.5h4V4M5 6v6M8 6v6M11 6v6" />
        <path d="m4 4 .6 9h6.8l.6-9" />
      </>
    );
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}

function itemLabel(type: SceneManagedTextItemType): string {
  return TYPE_OPTIONS.find((option) => option.value === type)?.label ?? "Line";
}

function itemPreview(item: SceneManagedTextItem): string {
  if (item.type === "icon") return (item.icon ?? item.text) || "No icon";
  if (item.type === "bullets") {
    return (
      item.points
        ?.map((point) => point.text)
        .filter(Boolean)
        .join(" · ") || "No points"
    );
  }
  return item.text?.trim() || "Empty line";
}

function CopyField({
  value,
  label,
  multiline = false,
  disabled,
  onCommit,
  onReturn,
  inputRef,
}: {
  value: string;
  label: string;
  multiline?: boolean;
  disabled?: boolean;
  onCommit: (value: string) => void;
  onReturn?: (value: string) => void;
  inputRef?: (element: HTMLInputElement | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  if (multiline) {
    return (
      <textarea
        className="modal-input text-inspector-copy-input"
        aria-label={label}
        value={draft}
        disabled={disabled}
        rows={3}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
      />
    );
  }
  return (
    <input
      ref={inputRef}
      className="modal-input text-inspector-copy-input"
      aria-label={label}
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onReturn?.(draft);
        }
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function ManagedTextDrill({
  doc,
  registrations = [],
  virtualOptions = {},
  virtualOptionsForDoc,
  selectedGroupKey: requestedGroupKey,
  selectedItemKey,
  backLabel = "Scene",
  onBack,
  onSelectGroup = () => undefined,
  onSelectItem,
  onOpenMotion,
  onOpenLook,
  onEditFont,
  theme = defaultTheme,
  colourDefaults = {},
  confirmTakeover,
  writeDoc,
  recentIcons = [],
  resolveIconPreview,
  onOpenEmoji,
  onChooseImage,
  onIconCommitted,
  alignment,
  mutateAlignment,
  mutateIcon,
  notice,
  disabled = false,
}: ManagedTextDrillProps) {
  const optionsFor = (source: SceneDoc) => virtualOptionsForDoc?.(source) ?? virtualOptions;
  const model = deriveManagedTextModel(doc, registrations, optionsFor(doc));
  const groups = resolveManagedTextGroups(model.items, doc.managedText?.groups, model.chromeKeys);
  const selectedGroup = selectedManagedTextGroup(groups, selectedItemKey, requestedGroupKey);
  const groupItems = selectedGroup?.items ?? [];
  const isSingleItemGroup = groupItems.length === 1;
  const selected = groupItems.find((item) => item.key === selectedItemKey) ?? groupItems[0] ?? null;
  // Host chrome (the comparison chips) owns copy and style only: it has no group, no type and no reveal of its own.
  const chromeGroup = selectedGroup ? isChromeManagedTextGroup(selectedGroup) : false;
  const chromeItem = selected ? model.chromeKeys.includes(selected.key) : false;
  const resolvedVirtualOptions = optionsFor(doc);
  const legacyIcon = resolvedVirtualOptions.icon ?? doc.headerIcon;
  const legacyIconKey = legacyIcon ? (resolvedVirtualOptions.iconKey ?? "icon") : null;
  const selectedIconNeedsTakeover =
    model.ownership === "authored" && selected?.type === "icon" && selected.key !== legacyIconKey;
  const selectedIconValue = selected?.type === "icon" ? (selected.icon ?? selected.text ?? "") : "";
  const itemListRef = useRef<HTMLOListElement | null>(null);
  const pointListRef = useRef<HTMLOListElement | null>(null);
  const addPointButtonRef = useRef<HTMLButtonElement | null>(null);
  const addElementButtonRef = useRef<HTMLButtonElement | null>(null);
  const itemButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const itemDrag = useRef<PointerReorderDrag | null>(null);
  const pointDrag = useRef<PointerReorderDrag | null>(null);
  const baselines = useRef(new Map<string, SceneDoc>());
  const pointRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [pendingPointFocus, setPendingPointFocus] = useState<"add" | string | null>(null);
  const [itemDragVisual, setItemDragVisual] = useState<PointerReorderDrag | null>(null);
  const [pointDragVisual, setPointDragVisual] = useState<PointerReorderDrag | null>(null);
  const [menu, setMenu] = useState<ManagedTextMenu | null>(null);
  const iconWriteRef = useRef<symbol | null>(null);
  const [iconWriteBusy, setIconWriteBusy] = useState(false);
  const mountedRef = useRef(true);
  const elementsHeadingId = useId();
  const displayedTextStyle =
    model.textStyle || doc.textStyle ? { ...model.textStyle, ...doc.textStyle } : undefined;
  const displayedDoc = displayedTextStyle ? { ...doc, textStyle: displayedTextStyle } : doc;
  const fallbackAlignment = alignment ?? doc.textLayout?.align ?? "center";
  const displayedAlignment = selectedGroup
    ? managedTextGroupAlignment(doc, selectedGroup.key, selectedGroup.align ?? fallbackAlignment)
    : fallbackAlignment;
  const resolveColour = (value: string) =>
    value === "text" || value === "muted" || value === "accent" ? theme.colors[value] : value;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!pendingPointFocus) return;
    const frame = window.requestAnimationFrame(() => {
      const target =
        pendingPointFocus === "add"
          ? addPointButtonRef.current
          : pointRefs.current[pendingPointFocus];
      if (!target) return;
      target.focus({ preventScroll: true });
      setPendingPointFocus(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingPointFocus]);

  const runStructural = async (
    action: ManagedTextStructuralAction,
    baseline = doc,
    historyBaseline?: SceneDoc,
    focusPointAfterSuccess?: "add" | string,
    focusItemAfterSuccess?: "add" | string,
  ) => {
    if (disabled) return;
    await performManagedTextStructuralAction({
      doc: baseline,
      registrations,
      virtualOptions: optionsFor(baseline),
      action,
      confirmTakeover,
      commit: async (result, history) => {
        let selectedItemKey = result.selectedItemKey;
        let selectedGroupKey = result.selectedGroupKey;
        let pointToFocus: string | null = null;
        const succeeded = await writeDoc({
          preview: result.doc,
          history,
          baseline: historyBaseline ?? baseline,
          historyFromBaseline: historyBaseline !== undefined,
          applyToCurrent: (current) => {
            const applied = applyManagedTextStructuralAction(
              current,
              action,
              registrations,
              optionsFor(current),
            );
            if (!applied) return current;
            if (action.type === "add-point") {
              const before = new Set(
                deriveManagedTextModel(current, registrations, optionsFor(current))
                  .items.find((item) => item.key === action.itemKey)
                  ?.points?.map((point) => point.key) ?? [],
              );
              pointToFocus =
                applied.doc.managedText?.items
                  .find((item) => item.key === action.itemKey)
                  ?.points?.find((point) => !before.has(point.key))?.key ?? null;
            }
            selectedItemKey = applied.selectedItemKey;
            selectedGroupKey = applied.selectedGroupKey;
            return applied.doc;
          },
        });
        if (succeeded !== false && mountedRef.current) {
          onSelectGroup(selectedGroupKey);
          onSelectItem(selectedItemKey);
          if (action.type === "remove-group" && selectedGroupKey === null) {
            onBack();
            return;
          }
          if (pointToFocus || focusPointAfterSuccess) {
            setPendingPointFocus(pointToFocus ?? focusPointAfterSuccess ?? null);
          }
          const focusTarget =
            focusItemAfterSuccess ??
            (action.type === "duplicate-item" || action.type === "add-item"
              ? (selectedItemKey ?? undefined)
              : undefined);
          if (focusTarget) {
            window.requestAnimationFrame(() => {
              const target =
                focusTarget === "add"
                  ? addElementButtonRef.current
                  : itemButtonRefs.current[focusTarget];
              const fallback = addElementButtonRef.current;
              if (target?.isConnected) target.focus({ preventScroll: true });
              else if (fallback?.isConnected) fallback.focus({ preventScroll: true });
            });
          }
        }
      },
    });
  };

  const openAddMenu = (button: HTMLButtonElement) => {
    if (!selectedGroup || disabled) return;
    const rect = button.getBoundingClientRect();
    setMenu({
      key: "add",
      kind: "add",
      state: {
        x: rect.left,
        y: rect.bottom + 4,
        ariaLabel: "Add text element",
        returnFocus: button,
        items: TYPE_OPTIONS.map((option) => ({
          id: `add-${option.value}`,
          label: `Add ${option.label.toLowerCase()}`,
          icon: option.icon,
          onSelect: () => {
            void runStructural({
              type: "add-item",
              groupKey: selectedGroup.key,
              itemType: option.value,
            });
          },
        })),
      },
    });
  };

  const openItemMenu = (
    item: SceneManagedTextItem,
    index: number,
    position: { x: number; y: number },
    returnFocus: HTMLElement | null,
  ) => {
    if (disabled) return;
    onSelectItem(item.key);
    const previous = groupItems[index - 1];
    const next = groupItems[index + 1];
    const accessibleItemLabel = `${itemLabel(item.type)} ${index + 1}: ${itemPreview(item)}`;
    setMenu({
      key: `item:${item.key}`,
      kind: "item",
      state: {
        ...position,
        ariaLabel: `Actions for ${accessibleItemLabel}`,
        returnFocus,
        items: [
          {
            id: "duplicate",
            label: "Duplicate",
            icon: <SmallIcon type="duplicate" />,
            onSelect: () => void runStructural({ type: "duplicate-item", itemKey: item.key }),
          },
          "separator",
          {
            id: "move-up",
            label: "Move up",
            icon: <SmallIcon type="up" />,
            disabled: !previous,
            onSelect: () => {
              if (!previous) return;
              void runStructural({
                type: "move-item",
                itemKey: item.key,
                toIndex: model.items.findIndex((candidate) => candidate.key === previous.key),
              });
            },
          },
          {
            id: "move-down",
            label: "Move down",
            icon: <SmallIcon type="down" />,
            disabled: !next,
            onSelect: () => {
              if (!next) return;
              void runStructural({
                type: "move-item",
                itemKey: item.key,
                toIndex: model.items.findIndex((candidate) => candidate.key === next.key),
              });
            },
          },
          "separator",
          {
            id: "delete",
            label: "Delete",
            confirmLabel: "Delete element?",
            danger: true,
            icon: <SmallIcon type="remove" />,
            onSelect: () => {
              const fallback = next?.key ?? previous?.key ?? "add";
              void runStructural(
                { type: "remove-item", itemKey: item.key },
                doc,
                undefined,
                undefined,
                fallback,
              );
            },
          },
        ],
      },
    });
  };

  const openItemMenuFromButton = (
    button: HTMLButtonElement,
    item: SceneManagedTextItem,
    index: number,
  ) => {
    const rect = button.getBoundingClientRect();
    openItemMenu(item, index, { x: rect.right, y: rect.bottom }, button);
  };

  const updatePointerDrag = (
    clientY: number,
    drag: PointerReorderDrag,
    list: HTMLOListElement | null,
  ): PointerReorderDrag => {
    const active = drag.active || Math.abs(clientY - drag.startY) >= POINTER_REORDER_THRESHOLD_PX;
    if (!active) return drag;
    return {
      ...drag,
      active: true,
      targetIndex: pointerReorderIndex(clientY, listRowBounds(list)) ?? drag.targetIndex,
    };
  };

  const startItemDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    key: string,
    index: number,
  ) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const drag = {
      pointerId: event.pointerId,
      key,
      startY: event.clientY,
      targetIndex: index,
      active: false,
    };
    itemDrag.current = drag;
    setItemDragVisual(drag);
  };

  const moveItemDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = itemDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = updatePointerDrag(event.clientY, drag, itemListRef.current);
    itemDrag.current = next;
    setItemDragVisual(next);
  };

  const finishItemDrag = (event: React.PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const drag = itemDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const finished = updatePointerDrag(event.clientY, drag, itemListRef.current);
    itemDrag.current = null;
    setItemDragVisual(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (cancelled || !finished.active) return;
    const target = groupItems[finished.targetIndex];
    const toIndex = target
      ? model.items.findIndex((candidate) => candidate.key === target.key)
      : -1;
    if (toIndex >= 0 && finished.key !== target?.key) {
      void runStructural({ type: "move-item", itemKey: finished.key, toIndex });
    }
  };

  const startPointDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    key: string,
    index: number,
  ) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const drag = {
      pointerId: event.pointerId,
      key,
      startY: event.clientY,
      targetIndex: index,
      active: false,
    };
    pointDrag.current = drag;
    setPointDragVisual(drag);
  };

  const movePointDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = pointDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = updatePointerDrag(event.clientY, drag, pointListRef.current);
    pointDrag.current = next;
    setPointDragVisual(next);
  };

  const finishPointDrag = (event: React.PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const drag = pointDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const finished = updatePointerDrag(event.clientY, drag, pointListRef.current);
    pointDrag.current = null;
    setPointDragVisual(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (cancelled || !finished.active || !selected) return;
    const target = selected.points?.[finished.targetIndex];
    if (target && finished.key !== target.key) {
      void runStructural({
        type: "move-point",
        itemKey: selected.key,
        pointKey: finished.key,
        toIndex: finished.targetIndex,
      });
    }
  };

  const commitCopy = (item: SceneManagedTextItem, value: string) => {
    if (disabled) return;
    const next = setManagedTextCopy(doc, item.key, value, registrations, optionsFor(doc));
    if (next) {
      void writeDoc({
        preview: next,
        history: "edit text copy",
        baseline: doc,
        applyToCurrent: (current) =>
          setManagedTextCopy(current, item.key, value, registrations, optionsFor(current)) ??
          current,
      });
    }
  };

  const commitPointCopy = (item: SceneManagedTextItem, pointKey: string, value: string) => {
    if (disabled) return;
    const next = setManagedTextPointCopy(
      doc,
      item.key,
      pointKey,
      value,
      registrations,
      optionsFor(doc),
    );
    if (next) {
      void writeDoc({
        preview: next,
        history: "edit bullet copy",
        baseline: doc,
        applyToCurrent: (current) =>
          setManagedTextPointCopy(
            current,
            item.key,
            pointKey,
            value,
            registrations,
            optionsFor(current),
          ) ?? current,
      });
    }
  };

  const commitIcon = (itemKey: string, value: string | undefined) => {
    if (disabled || iconWriteRef.current) return;
    const update = (source: SceneDoc) =>
      source.managedText !== undefined || !mutateIcon
        ? setManagedTextIcon(source, itemKey, value, registrations, optionsFor(source))
        : mutateIcon(source, itemKey, value);
    const next = update(doc);
    if (next) {
      const token = Symbol("managed-text-icon-write");
      iconWriteRef.current = token;
      setIconWriteBusy(true);
      void (async () => {
        try {
          const succeeded = await writeDoc({
            preview: next,
            history: "change text icon",
            baseline: doc,
            applyToCurrent: (current) => update(current) ?? current,
          });
          if (succeeded !== false && value) onIconCommitted?.(value);
        } finally {
          if (iconWriteRef.current === token) {
            iconWriteRef.current = null;
            if (mountedRef.current) setIconWriteBusy(false);
          }
        }
      })();
    }
  };

  const commitAlignment = (align: SceneTextAlign) => {
    if (disabled || !selectedGroup) return;
    const update = (source: SceneDoc) =>
      source.managedText
        ? setManagedTextGroupAlignment(source, selectedGroup.key, align, optionsFor(source))
        : mutateAlignment
          ? mutateAlignment(source, align)
          : setManagedTextAlignment(source, align);
    const next = update(doc);
    if (!next) return;
    void writeDoc({
      preview: next,
      history: "text alignment",
      baseline: doc,
      applyToCurrent: (current) => update(current) ?? current,
    });
  };

  const commitColour = (itemKey: string, value: string | undefined) => {
    if (disabled) return;
    const next = setManagedTextColour(doc, itemKey, value, registrations, optionsFor(doc));
    if (!next) return;
    void writeDoc({
      preview: next,
      history: "text colour",
      baseline: doc,
      applyToCurrent: (current) =>
        setManagedTextColour(current, itemKey, value, registrations, optionsFor(current)) ??
        current,
    });
  };

  const styleControl = (
    field: "size" | "x" | "y" | "rotation" | "spacing",
    value: number,
    history: string,
  ) => {
    const baselineKey = `style:${selected?.key ?? ""}:${field}`;
    const write = (nextValue: number, live: boolean) => {
      if (!selected || disabled) return;
      let baseline = baselines.current.get(baselineKey);
      if (live && !baseline) {
        baseline = doc;
        baselines.current.set(baselineKey, baseline);
      }
      baseline ??= doc;
      const next = setManagedTextStyle(baseline, selected.key, field, nextValue);
      if (!next) return;
      const applyToCurrent = (current: SceneDoc) =>
        setManagedTextStyle(current, selected.key, field, nextValue) ?? current;
      if (live) void writeDoc({ preview: next, history: false, baseline, applyToCurrent });
      else {
        baselines.current.delete(baselineKey);
        void writeDoc({
          preview: next,
          history,
          baseline,
          historyFromBaseline: true,
          applyToCurrent,
        });
      }
    };
    return {
      value,
      onInput: (nextValue: number) => write(nextValue, true),
      onCommit: (nextValue: number) => write(nextValue, false),
    };
  };

  const bulletSlider = (field: "pointGap" | "indent") => {
    const baselineKey = `bullet:${selected?.key ?? ""}:${field}`;
    const action = (nextValue: number): ManagedTextStructuralAction =>
      field === "pointGap"
        ? { type: "set-point-gap", itemKey: selected?.key ?? "", pointGap: nextValue }
        : { type: "set-indent", itemKey: selected?.key ?? "", indent: nextValue };
    return {
      onInput: (nextValue: number) => {
        if (!selected || disabled || doc.managedText === undefined) return;
        let baseline = baselines.current.get(baselineKey);
        if (!baseline) {
          baseline = doc;
          baselines.current.set(baselineKey, baseline);
        }
        const result = applyManagedTextStructuralAction(
          baseline,
          action(nextValue),
          registrations,
          optionsFor(baseline),
        );
        if (result) {
          void writeDoc({
            preview: result.doc,
            history: false,
            baseline,
            applyToCurrent: (current) =>
              applyManagedTextStructuralAction(
                current,
                action(nextValue),
                registrations,
                optionsFor(current),
              )?.doc ?? current,
          });
        }
      },
      onCommit: (nextValue: number) => {
        if (!selected || disabled) return;
        const baseline = baselines.current.get(baselineKey) ?? doc;
        baselines.current.delete(baselineKey);
        void runStructural(action(nextValue), baseline, baseline);
      },
    };
  };

  const motionSpec = selected
    ? (doc.textAnimationOverrides?.[selected.key] ??
      model.textAnimationOverrides?.[selected.key] ??
      doc.textAnimation)
    : undefined;
  const hasItemMotion =
    selected !== null &&
    (doc.textAnimationOverrides?.[selected.key] !== undefined ||
      model.textAnimationOverrides?.[selected.key] !== undefined);
  const motionValue = `${describeManagedTextMotion(motionSpec)}${
    hasItemMotion ? " · This line" : " · All lines"
  }`;
  const lookSpec = selected
    ? (doc.textLookOverrides?.[selected.key] ??
      model.textLookOverrides?.[selected.key] ??
      doc.textLook)
    : undefined;
  const hasItemLook =
    selected !== null &&
    (doc.textLookOverrides?.[selected.key] !== undefined ||
      model.textLookOverrides?.[selected.key] !== undefined);
  const lookValue = `${describeManagedTextLook(lookSpec)}${
    hasItemLook ? " · This line" : " · All lines"
  }`;
  // Controls the mounted primitive flags inert; a row with no hint shows everything.
  const inertControls = new Set(selected ? (model.inertStyleControls?.[selected.key] ?? []) : []);
  const showLookRow = onOpenLook !== undefined && selected?.type !== "icon";

  return (
    <div className="inspector-drill text-inspector-drill" aria-busy={disabled || undefined}>
      <DrillBack
        label={backLabel}
        title="Text"
        onClick={onBack}
        actions={
          selectedGroup && !chromeGroup ? (
            <>
              <DrillHeaderAction
                kind="duplicate"
                label="Duplicate text group"
                disabled={disabled}
                onClick={() =>
                  void runStructural({ type: "duplicate-group", groupKey: selectedGroup.key })
                }
              />
              <DrillHeaderAction
                kind="remove"
                label="Remove text group"
                disabled={disabled}
                onClick={() =>
                  void runStructural({ type: "remove-group", groupKey: selectedGroup.key })
                }
              />
            </>
          ) : undefined
        }
      />
      <div className="inspector-drill-scroll text-inspector-scroll">
        {notice && (
          <p className="inspector-error" role="alert">
            {notice}
          </p>
        )}
        {chromeGroup ? null : isSingleItemGroup ? (
          <section className="text-inspector-single-controls" aria-label="Text controls">
            <div className="text-inspector-section-heading">
              <span className="drill-group-label">Alignment</span>
              <button
                ref={addElementButtonRef}
                type="button"
                className="text-inspector-icon-button text-inspector-add-line"
                aria-label="Add text element"
                aria-haspopup="menu"
                aria-expanded={menu?.kind === "add"}
                title="Add text element"
                disabled={disabled || !selectedGroup}
                onClick={(event) => {
                  if (menu?.kind === "add") setMenu(null);
                  else openAddMenu(event.currentTarget);
                }}
              >
                <SmallIcon type="add" />
              </button>
            </div>
            <SegmentedRow
              className="text-inspector-alignment-segments"
              ariaLabel="Text alignment"
              options={ALIGNMENT_OPTIONS}
              value={displayedAlignment}
              onChange={commitAlignment}
              disabled={disabled}
            />
          </section>
        ) : (
          <section className="text-inspector-copy-sheet" aria-labelledby={elementsHeadingId}>
            <div className="text-inspector-section-heading">
              <span id={elementsHeadingId} className="drill-group-label">
                Text group
              </span>
              <button
                ref={addElementButtonRef}
                type="button"
                className="text-inspector-icon-button text-inspector-add-line"
                aria-label="Add text element"
                aria-haspopup="menu"
                aria-expanded={menu?.kind === "add"}
                title="Add text element"
                disabled={disabled || !selectedGroup}
                onClick={(event) => {
                  if (menu?.kind === "add") setMenu(null);
                  else openAddMenu(event.currentTarget);
                }}
              >
                <SmallIcon type="add" />
              </button>
            </div>
            <SegmentedRow
              className="text-inspector-alignment-segments"
              ariaLabel="Text group alignment"
              options={ALIGNMENT_OPTIONS}
              value={displayedAlignment}
              onChange={commitAlignment}
              disabled={disabled}
            />
            {groupItems.length === 0 ? (
              <p className="inspector-empty text-inspector-empty">No copy selected</p>
            ) : (
              <ol ref={itemListRef} className="text-inspector-line-list">
                {groupItems.map((item, index) => {
                  const active = item.key === selected?.key;
                  const accessibleItemLabel = `${itemLabel(item.type)} ${index + 1}: ${itemPreview(item)}`;
                  const dragging = itemDragVisual?.active && itemDragVisual.key === item.key;
                  const dropTarget =
                    itemDragVisual?.active && itemDragVisual.targetIndex === index && !dragging;
                  return (
                    <li
                      key={item.key}
                      className={`text-inspector-line${active ? " active" : ""}${
                        dragging ? " dragging" : ""
                      }${dropTarget ? " drop-target" : ""}`}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        openItemMenu(
                          item,
                          index,
                          { x: event.clientX, y: event.clientY },
                          itemButtonRefs.current[item.key],
                        );
                      }}
                    >
                      <button
                        type="button"
                        className="text-inspector-line-grip"
                        aria-label={`Reorder ${accessibleItemLabel}`}
                        disabled={disabled}
                        onPointerDown={(event) => startItemDrag(event, item.key, index)}
                        onPointerMove={moveItemDrag}
                        onPointerUp={finishItemDrag}
                        onPointerCancel={(event) => finishItemDrag(event, true)}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowUp" && index > 0) {
                            event.preventDefault();
                            void runStructural({
                              type: "move-item",
                              itemKey: item.key,
                              toIndex: model.items.findIndex(
                                (candidate) => candidate.key === groupItems[index - 1]?.key,
                              ),
                            });
                          }
                          if (event.key === "ArrowDown" && index < groupItems.length - 1) {
                            event.preventDefault();
                            const nextKey = groupItems[index + 1]?.key;
                            const toIndex = model.items.findIndex(
                              (candidate) => candidate.key === nextKey,
                            );
                            void runStructural({
                              type: "move-item",
                              itemKey: item.key,
                              toIndex,
                            });
                          }
                        }}
                      >
                        <SmallIcon type="grip" />
                      </button>
                      <button
                        ref={(element) => {
                          itemButtonRefs.current[item.key] = element;
                        }}
                        type="button"
                        className="text-inspector-line-select"
                        aria-pressed={active}
                        disabled={disabled}
                        onClick={() => onSelectItem(item.key)}
                        onKeyDown={(event) => {
                          if (
                            event.key !== "ContextMenu" &&
                            !(event.shiftKey && event.key === "F10")
                          ) {
                            return;
                          }
                          event.preventDefault();
                          openItemMenuFromButton(event.currentTarget, item, index);
                        }}
                      >
                        <span className="text-inspector-line-type">{itemLabel(item.type)}</span>
                        <span className="text-inspector-line-preview" title={itemPreview(item)}>
                          {itemPreview(item)}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="text-inspector-line-menu"
                        aria-label={`More actions for ${accessibleItemLabel}`}
                        aria-haspopup="menu"
                        aria-expanded={menu?.key === `item:${item.key}`}
                        disabled={disabled}
                        onClick={(event) =>
                          openItemMenuFromButton(event.currentTarget, item, index)
                        }
                      >
                        <SmallIcon type="more" />
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        )}

        {selected && (
          <>
            <section
              className="text-inspector-element-editor"
              aria-label={`${itemLabel(selected.type)} element`}
            >
              {!chromeItem && (
                <SegmentedRow
                  className="text-inspector-type-segments"
                  ariaLabel="Element type"
                  options={TYPE_OPTIONS}
                  value={selected.type}
                  disabled={disabled}
                  onChange={(itemType) =>
                    void runStructural({ type: "change-type", itemKey: selected.key, itemType })
                  }
                />
              )}
              <div className="text-inspector-element-fields">
                {(selected.type === "title" || selected.type === "subtitle") && (
                  <CopyField
                    value={selected.text ?? ""}
                    label={`${itemLabel(selected.type)} copy`}
                    multiline
                    disabled={disabled}
                    onCommit={(value) => commitCopy(selected, value)}
                  />
                )}
                {selected.type === "bullets" && (
                  <div className="text-inspector-bullets">
                    <ol ref={pointListRef} className="text-inspector-point-list">
                      {(selected.points ?? []).map((point, pointIndex) => (
                        <li
                          key={point.key}
                          className={`text-inspector-point-row${
                            pointDragVisual?.active && pointDragVisual.key === point.key
                              ? " dragging"
                              : ""
                          }${
                            pointDragVisual?.active &&
                            pointDragVisual.targetIndex === pointIndex &&
                            pointDragVisual.key !== point.key
                              ? " drop-target"
                              : ""
                          }`}
                        >
                          <button
                            type="button"
                            className="text-inspector-point-grip"
                            aria-label={`Reorder point ${pointIndex + 1}`}
                            disabled={disabled}
                            onPointerDown={(event) => startPointDrag(event, point.key, pointIndex)}
                            onPointerMove={movePointDrag}
                            onPointerUp={finishPointDrag}
                            onPointerCancel={(event) => finishPointDrag(event, true)}
                            onKeyDown={(event) => {
                              if (event.key === "ArrowUp" && pointIndex > 0) {
                                event.preventDefault();
                                void runStructural({
                                  type: "move-point",
                                  itemKey: selected.key,
                                  pointKey: point.key,
                                  toIndex: pointIndex - 1,
                                });
                              }
                              if (
                                event.key === "ArrowDown" &&
                                pointIndex < (selected.points?.length ?? 0) - 1
                              ) {
                                event.preventDefault();
                                void runStructural({
                                  type: "move-point",
                                  itemKey: selected.key,
                                  pointKey: point.key,
                                  toIndex: pointIndex + 1,
                                });
                              }
                            }}
                          >
                            <SmallIcon type="grip" />
                          </button>
                          <CopyField
                            value={point.text}
                            label={`Point ${pointIndex + 1}`}
                            disabled={disabled}
                            inputRef={(element) => {
                              pointRefs.current[point.key] = element;
                            }}
                            onCommit={(value) => commitPointCopy(selected, point.key, value)}
                            onReturn={(afterPointText) =>
                              void runStructural({
                                type: "add-point",
                                itemKey: selected.key,
                                afterPointKey: point.key,
                                afterPointText,
                              })
                            }
                          />
                          <button
                            type="button"
                            className="text-inspector-point-remove"
                            aria-label={`Remove point ${pointIndex + 1}`}
                            disabled={disabled}
                            onClick={() => {
                              const focusAfterRemove =
                                selected.points?.[pointIndex + 1]?.key ??
                                selected.points?.[pointIndex - 1]?.key ??
                                "add";
                              void runStructural(
                                {
                                  type: "remove-point",
                                  itemKey: selected.key,
                                  pointKey: point.key,
                                },
                                doc,
                                undefined,
                                focusAfterRemove,
                              );
                            }}
                          >
                            <SmallIcon type="remove" />
                          </button>
                        </li>
                      ))}
                    </ol>
                    <button
                      ref={addPointButtonRef}
                      type="button"
                      className="btn small text-inspector-add-point"
                      disabled={disabled}
                      onClick={() =>
                        void runStructural({ type: "add-point", itemKey: selected.key })
                      }
                    >
                      <SmallIcon type="add" />
                      Point
                    </button>
                    <fieldset className="text-inspector-marker-fieldset" disabled={disabled}>
                      <legend>Marker</legend>
                      <div className="text-inspector-marker-grid">
                        {MARKERS.map((marker) => (
                          <button
                            key={marker.value}
                            type="button"
                            aria-label={`${marker.label} marker`}
                            aria-pressed={(selected.marker ?? "dot") === marker.value}
                            title={marker.label}
                            onClick={() =>
                              void runStructural({
                                type: "set-marker",
                                itemKey: selected.key,
                                marker: marker.value,
                              })
                            }
                          >
                            {marker.preview}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                    <InspectorSliderRow
                      icon={<TextControlIcon type="gap" />}
                      label="Point gap"
                      value={selected.pointGap ?? 0.14}
                      min={0}
                      max={1}
                      step={0.01}
                      disabled={disabled}
                      {...bulletSlider("pointGap")}
                    />
                    <InspectorSliderRow
                      icon={<TextControlIcon type="indent" />}
                      label="Indent"
                      value={selected.indent ?? 0.2}
                      min={0}
                      max={1.5}
                      step={0.01}
                      disabled={disabled}
                      {...bulletSlider("indent")}
                    />
                  </div>
                )}
                {selected.type === "icon" && (
                  <div className="text-inspector-icon-editor">
                    <div
                      className="text-inspector-icon-preview"
                      role="img"
                      aria-label={
                        selectedIconValue
                          ? `Icon preview: ${selectedIconValue}`
                          : "No icon selected"
                      }
                    >
                      {selectedIconValue && resolveIconPreview?.(selectedIconValue) ? (
                        <img src={resolveIconPreview(selectedIconValue)} alt="" />
                      ) : (
                        <span>{selectedIconValue || "No icon"}</span>
                      )}
                    </div>
                    {selectedIconNeedsTakeover ? (
                      <div className="text-inspector-icon-takeover">
                        <p className="inspector-stub-note">
                          This icon is controlled by scene code. Take over the text block before
                          changing its source, placement or motion.
                        </p>
                        <button
                          type="button"
                          className="btn small"
                          disabled={disabled}
                          onClick={() =>
                            void runStructural({ type: "take-over", itemKey: selected.key })
                          }
                        >
                          Take over to edit
                        </button>
                      </div>
                    ) : (
                      <>
                        <fieldset
                          className="text-inspector-icon-recents"
                          disabled={disabled || iconWriteBusy}
                        >
                          <legend>Quick emoji</legend>
                          <div className="text-inspector-icon-recent-grid text-inspector-icon-quick-grid">
                            {HEADER_EMOJIS.map((emoji) => (
                              <button
                                key={emoji}
                                type="button"
                                aria-label={`Use emoji ${emoji}`}
                                aria-pressed={selectedIconValue === emoji}
                                onClick={() => commitIcon(selected.key, emoji)}
                              >
                                {emoji}
                              </button>
                            ))}
                          </div>
                        </fieldset>
                        <div className="text-inspector-icon-actions">
                          <button
                            type="button"
                            className="btn small"
                            disabled={disabled || iconWriteBusy || !onOpenEmoji}
                            onClick={async () => {
                              const value = await onOpenEmoji?.(selected.key);
                              if (value !== undefined) commitIcon(selected.key, value);
                            }}
                          >
                            All emoji
                          </button>
                          <button
                            type="button"
                            className="btn small"
                            disabled={disabled || iconWriteBusy || !onChooseImage}
                            onClick={async () => {
                              const value = await onChooseImage?.(selected.key);
                              if (value !== undefined) commitIcon(selected.key, value);
                            }}
                          >
                            Image…
                          </button>
                          <button
                            type="button"
                            className="btn small"
                            disabled={disabled || iconWriteBusy || !selectedIconValue}
                            onClick={() => commitIcon(selected.key, undefined)}
                          >
                            Clear
                          </button>
                        </div>
                        {recentIcons.length > 0 && (
                          <fieldset
                            className="text-inspector-icon-recents"
                            disabled={disabled || iconWriteBusy}
                          >
                            <legend>Recent</legend>
                            <div className="text-inspector-icon-recent-grid">
                              {recentIcons.map((icon) => (
                                <button
                                  key={icon}
                                  type="button"
                                  aria-label={`Use recent icon ${icon}`}
                                  aria-pressed={selectedIconValue === icon}
                                  onClick={() => commitIcon(selected.key, icon)}
                                >
                                  {resolveIconPreview?.(icon) ? (
                                    <img src={resolveIconPreview(icon)} alt="" />
                                  ) : (
                                    icon
                                  )}
                                </button>
                              ))}
                            </div>
                          </fieldset>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </section>

            {selected.type !== "icon" &&
              (!inertControls.has("font") || !inertControls.has("colour")) && (
                <DrillGroup label="Style">
                  {!inertControls.has("font") && (
                    <ActionRow
                      icon={<TextControlIcon type="font" />}
                      label="Font"
                      value={
                        typeof displayedTextStyle?.[`${selected.key}Font`] === "string"
                          ? String(displayedTextStyle[`${selected.key}Font`]).split("@")[0]
                          : "Theme"
                      }
                      disabled={disabled}
                      onClick={() => onEditFont(selected.key)}
                    />
                  )}
                  {!inertControls.has("colour") &&
                    (() => {
                      const styleKey = `${selected.key}Color`;
                      const override = doc.textStyle?.[styleKey];
                      const virtualColour = model.textStyle?.[styleKey];
                      const defaultToken =
                        colourDefaults[selected.key] ??
                        (selected.type === "subtitle" ? "muted" : "text");
                      const defaultColour = resolveColour(defaultToken);
                      const currentColour = resolveColour(
                        typeof override === "string"
                          ? override
                          : typeof virtualColour === "string"
                            ? virtualColour
                            : defaultToken,
                      );
                      return (
                        <div className="popover-row text-inspector-colour-row">
                          <span className="action-row-icon">
                            <TextControlIcon type="colour" />
                          </span>
                          <span className="popover-inline">Colour</span>
                          <span className="action-row-value">{currentColour.toUpperCase()}</span>
                          <ColourPicker
                            key={selected.key}
                            value={currentColour}
                            defaultValue={defaultColour}
                            label={`${itemLabel(selected.type)} colour`}
                            disabled={disabled}
                            theme={theme}
                            onCommit={(hex) => commitColour(selected.key, hex)}
                            onReset={
                              typeof override === "string"
                                ? () => commitColour(selected.key, undefined)
                                : undefined
                            }
                          />
                        </div>
                      );
                    })()}
                </DrillGroup>
              )}

            {!selectedIconNeedsTakeover && (
              <DrillGroup label="Placement">
                <div className="text-inspector-numeric-grid">
                  {!inertControls.has("size") && (
                    <NumberField
                      label="Size %"
                      decimals={0}
                      min={10}
                      max={400}
                      step={1}
                      disabled={disabled}
                      {...styleControl(
                        "size",
                        managedTextStyleValue(displayedDoc, selected.key, "size") * 100,
                        "text size",
                      )}
                      onInput={(value) =>
                        styleControl("size", value, "text size").onInput(value / 100)
                      }
                      onCommit={(value) =>
                        styleControl("size", value, "text size").onCommit(value / 100)
                      }
                    />
                  )}
                  {!inertControls.has("x") && (
                    <NumberField
                      label="X"
                      decimals={2}
                      min={-10}
                      max={10}
                      step={0.01}
                      disabled={disabled}
                      {...styleControl(
                        "x",
                        managedTextStyleValue(displayedDoc, selected.key, "x"),
                        "text X position",
                      )}
                    />
                  )}
                  {!inertControls.has("y") && (
                    <NumberField
                      label="Y"
                      decimals={2}
                      min={-10}
                      max={10}
                      step={0.01}
                      disabled={disabled}
                      {...styleControl(
                        "y",
                        managedTextStyleValue(displayedDoc, selected.key, "y"),
                        "text Y position",
                      )}
                    />
                  )}
                  {!inertControls.has("rotation") && (
                    <NumberField
                      label="Rotation °"
                      decimals={1}
                      min={-180}
                      max={180}
                      step={0.5}
                      disabled={disabled}
                      {...styleControl(
                        "rotation",
                        managedTextStyleValue(displayedDoc, selected.key, "rotation"),
                        "text rotation",
                      )}
                    />
                  )}
                </div>
                {selected.type !== "icon" && !inertControls.has("spacing") && (
                  <InspectorSliderRow
                    icon={<TextControlIcon type="spacing" />}
                    label="Spacing"
                    min={0.8}
                    max={2}
                    step={0.05}
                    disabled={disabled}
                    {...styleControl(
                      "spacing",
                      managedTextStyleValue(displayedDoc, selected.key, "spacing"),
                      "text spacing",
                    )}
                  />
                )}
              </DrillGroup>
            )}

            {!selectedIconNeedsTakeover && !chromeItem && (
              <DrillGroup label={showLookRow ? "Motion and style" : "Motion"}>
                <ActionRow
                  icon={<TextControlIcon type="motion" />}
                  label="Text motion"
                  value={motionValue}
                  disabled={disabled}
                  onClick={() => onOpenMotion(selected.key)}
                />
                {showLookRow && (
                  <ActionRow
                    icon={<TextControlIcon type="look" />}
                    label="Text style"
                    value={lookValue}
                    disabled={disabled}
                    onClick={() => onOpenLook?.(selected.key)}
                  />
                )}
              </DrillGroup>
            )}
          </>
        )}
      </div>
      {menu && <ContextMenu key={menu.key} menu={menu.state} onClose={() => setMenu(null)} />}
    </div>
  );
}
