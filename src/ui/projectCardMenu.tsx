import type { ContextMenuItem } from "./ContextMenu";
import { SceneMenuIcon } from "./sceneMenu";

/** The project card menu both openers share (the ⋯ button and right-click): rename, duplicate, move to group, then the two-step delete. */
export function projectCardMenuItems(opts: {
  onRename: () => void;
  onDuplicate: () => void;
  onMoveToGroup: () => void;
  onDelete: () => void;
}): (ContextMenuItem | "separator")[] {
  return [
    {
      id: "rename",
      label: "Rename…",
      icon: <SceneMenuIcon id="rename" />,
      onSelect: opts.onRename,
    },
    {
      id: "duplicate",
      label: "Duplicate…",
      icon: <SceneMenuIcon id="duplicate" />,
      onSelect: opts.onDuplicate,
    },
    {
      id: "group",
      label: "Move to group…",
      icon: <SceneMenuIcon id="move-to-group" />,
      onSelect: opts.onMoveToGroup,
    },
    "separator",
    {
      id: "delete",
      label: "Delete",
      icon: <SceneMenuIcon id="delete" />,
      confirmLabel: "Really delete?",
      danger: true,
      title: "Moves the project folder to the Trash",
      onSelect: opts.onDelete,
    },
  ];
}
