import type { ContextMenuItem } from "./ContextMenu";

/** The scene context menu both surfaces share (the timeline's labels and the Scenes drill-in): same items, order and guards; each surface supplies its own inline-edit and dialog handlers. */
export function sceneMenuItems(opts: {
  canRename: boolean;
  lastScene: boolean;
  hasClipboard: boolean;
  onRename: () => void;
  onDuplicate: () => void;
  onDuration: () => void;
  onCopyBackground: () => void;
  onPasteBackground: () => void;
  onDelete: () => void;
  /** Timeline surfaces pass this to add a jump to the Scenes manager; the manager omits it. */
  onManage?: () => void;
}): (ContextMenuItem | "separator")[] {
  return [
    {
      id: "rename",
      label: "Rename",
      disabled: !opts.canRename,
      title: opts.canRename ? undefined : "This scene has no scene document yet",
      onSelect: opts.onRename,
    },
    { id: "duplicate", label: "Duplicate…", onSelect: opts.onDuplicate },
    { id: "duration", label: "Change duration…", onSelect: opts.onDuration },
    ...(opts.onManage
      ? [{ id: "manage", label: "Manage scenes…", onSelect: opts.onManage } as ContextMenuItem]
      : []),
    "separator",
    { id: "copy-background", label: "Copy background", onSelect: opts.onCopyBackground },
    {
      id: "paste-background",
      label: "Paste background",
      disabled: !opts.hasClipboard,
      title: opts.hasClipboard ? undefined : "Copy a scene's background first",
      onSelect: opts.onPasteBackground,
    },
    "separator",
    {
      id: "delete",
      label: "Delete",
      confirmLabel: "Really delete?",
      danger: true,
      disabled: opts.lastScene,
      title: opts.lastScene ? "A project needs at least one scene" : undefined,
      onSelect: opts.onDelete,
    },
  ];
}
