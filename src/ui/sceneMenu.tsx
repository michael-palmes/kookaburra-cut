import type { ContextMenuItem } from "./ContextMenu";

/** The action label for a scene selection: one scene keeps the bare verb, more take the count ("Delete 3 scenes"). */
export function sceneSelectionLabel(verb: string, count: number): string {
  return count > 1 ? `${verb} ${count} scenes` : verb;
}

/** The scene context menu both surfaces share (the timeline's labels and the Scenes drill-in): same items, order and guards; each surface supplies its own inline-edit and dialog handlers. */
export function sceneMenuItems(opts: {
  canRename: boolean;
  /** The delete may proceed: false for the last scene, or a selection covering every scene (Rust keeps at least one). */
  canDelete: boolean;
  hasClipboard: boolean;
  onRename: () => void;
  onDuplicate: () => void;
  onDuration: () => void;
  onCopyBackground: () => void;
  onPasteBackground: () => void;
  onDelete: () => void;
  /** Timeline surfaces pass this to add a jump to the Scenes manager; the manager omits it. */
  onManage?: () => void;
  /** Scenes-manager multi-select: > 1 relabels Duplicate, Copy to project and Delete to the bulk actions. */
  selectionCount?: number;
  /** Workspace projects only: opens the copy-to-project picker (bulk when selectionCount > 1). */
  onCopyToProject?: () => void;
}): (ContextMenuItem | "separator")[] {
  const count = opts.selectionCount ?? 0;
  const bulk = count > 1;
  return [
    {
      id: "rename",
      label: "Rename",
      disabled: !opts.canRename,
      title: opts.canRename ? undefined : "This scene has no scene document yet",
      onSelect: opts.onRename,
    },
    {
      id: "duplicate",
      label: bulk ? sceneSelectionLabel("Duplicate", count) : "Duplicate…",
      onSelect: opts.onDuplicate,
    },
    ...(opts.onCopyToProject
      ? [
          {
            id: "copy-to-project",
            label: bulk ? `Copy ${count} scenes to project…` : "Copy to project…",
            onSelect: opts.onCopyToProject,
          } as ContextMenuItem,
        ]
      : []),
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
      label: sceneSelectionLabel("Delete", count),
      confirmLabel: "Really delete?",
      danger: true,
      disabled: !opts.canDelete,
      title: opts.canDelete ? undefined : "A project needs at least one scene",
      onSelect: opts.onDelete,
    },
  ];
}
