import type { ContextMenuItem } from "./ContextMenu";

/** The action label for a scene selection: one scene keeps the bare verb, more take the count ("Delete 3 scenes"). */
export function sceneSelectionLabel(verb: string, count: number): string {
  return count > 1 ? `${verb} ${count} scenes` : verb;
}

export type SceneMenuIconId =
  | "rename"
  | "duplicate"
  | "copy-to-project"
  | "duration"
  | "manage"
  | "copy-background"
  | "paste-background"
  | "delete";

/** Leading glyphs for the scene menu and the scene manager's footer: the Project tab's 20-viewBox stroke style. */
export function SceneMenuIcon({ id }: { id: SceneMenuIconId }) {
  switch (id) {
    case "rename":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M4 16l.9-3.4 8-8a1.6 1.6 0 012.3 0l.2.2a1.6 1.6 0 010 2.3l-8 8L4 16z" />
          <path d="M11.5 6.5l2 2" />
        </svg>
      );
    case "duplicate":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
          <rect x="7.5" y="7.5" width="9" height="9" rx="1.5" />
        </svg>
      );
    case "copy-to-project":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="9.5" y="4.5" width="7" height="11" rx="1.5" />
          <path d="M3.5 10h5.5M6.5 7.5L9 10l-2.5 2.5" />
        </svg>
      );
    case "duration":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <circle cx="10" cy="10" r="6.5" />
          <path d="M10 6.5V10l2.5 2" />
        </svg>
      );
    case "manage":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M4 5.5h12M4 10h12M4 14.5h8" />
        </svg>
      );
    case "copy-background":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="6.5" y="3.5" width="10" height="9" rx="1.5" />
          <path d="M6.5 10.5l2.5-2.5 2 2 1.5-1.5 3 3" />
          <path d="M13.5 16h-8A1.5 1.5 0 014 14.5v-8" />
        </svg>
      );
    case "paste-background":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M7.5 4H6a1.5 1.5 0 00-1.5 1.5v10A1.5 1.5 0 006 17h8a1.5 1.5 0 001.5-1.5v-10A1.5 1.5 0 0014 4h-1.5" />
          <rect x="7.5" y="2.5" width="5" height="3" rx="1" />
          <path d="M7 13.5l2-2 1.5 1.5 1.5-1.5 1.5 1.5" />
        </svg>
      );
    case "delete":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M4 6h12M8 6V4.5A1.5 1.5 0 019.5 3h1A1.5 1.5 0 0112 4.5V6m2.5 0l-.7 9.2A1.5 1.5 0 0112.3 17H7.7a1.5 1.5 0 01-1.5-1.8L5.5 6" />
        </svg>
      );
  }
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
      icon: <SceneMenuIcon id="rename" />,
      disabled: !opts.canRename,
      title: opts.canRename ? undefined : "This scene has no scene document yet",
      onSelect: opts.onRename,
    },
    {
      id: "duplicate",
      label: bulk ? sceneSelectionLabel("Duplicate", count) : "Duplicate…",
      icon: <SceneMenuIcon id="duplicate" />,
      onSelect: opts.onDuplicate,
    },
    ...(opts.onCopyToProject
      ? [
          {
            id: "copy-to-project",
            label: bulk ? `Copy ${count} scenes to project…` : "Copy to project…",
            icon: <SceneMenuIcon id="copy-to-project" />,
            onSelect: opts.onCopyToProject,
          } as ContextMenuItem,
        ]
      : []),
    {
      id: "duration",
      label: "Change duration…",
      icon: <SceneMenuIcon id="duration" />,
      onSelect: opts.onDuration,
    },
    ...(opts.onManage
      ? [
          {
            id: "manage",
            label: "Manage scenes…",
            icon: <SceneMenuIcon id="manage" />,
            onSelect: opts.onManage,
          } as ContextMenuItem,
        ]
      : []),
    "separator",
    {
      id: "copy-background",
      label: "Copy background",
      icon: <SceneMenuIcon id="copy-background" />,
      onSelect: opts.onCopyBackground,
    },
    {
      id: "paste-background",
      label: "Paste background",
      icon: <SceneMenuIcon id="paste-background" />,
      disabled: !opts.hasClipboard,
      title: opts.hasClipboard ? undefined : "Copy a scene's background first",
      onSelect: opts.onPasteBackground,
    },
    "separator",
    {
      id: "delete",
      label: sceneSelectionLabel("Delete", count),
      icon: <SceneMenuIcon id="delete" />,
      confirmLabel: "Really delete?",
      danger: true,
      disabled: !opts.canDelete,
      title: opts.canDelete ? undefined : "A project needs at least one scene",
      onSelect: opts.onDelete,
    },
  ];
}
