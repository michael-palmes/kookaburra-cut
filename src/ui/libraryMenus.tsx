import type { ContextMenuItem } from "./ContextMenu";
import type { LibraryKind, LibrarySource } from "./libraryDetails";
import { LibraryMenuIcon } from "./libraryIcons";
import { SceneMenuIcon } from "./sceneMenu";

/** Item builders for the welcome screen's right-click menus (the `sceneMenu.tsx` pattern): the project cards and the four library grids. Every item carries a leading icon (design rule 10), and the destructive ones arm through the shared two-step rather than a confirm dialog. */

export function projectCardMenuItems(opts: {
  onRename: () => void;
  onDuplicate: () => void;
  onGroup: () => void;
  onConvert: () => void;
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
      icon: <LibraryMenuIcon id="group" />,
      onSelect: opts.onGroup,
    },
    "separator",
    {
      id: "convert",
      label: "Convert to template…",
      icon: <LibraryMenuIcon id="convert" />,
      onSelect: opts.onConvert,
    },
    "separator",
    {
      id: "delete",
      label: "Delete…",
      icon: <SceneMenuIcon id="delete" />,
      confirmLabel: "Really delete?",
      danger: true,
      title: "Moves the project folder to the Trash",
      onSelect: opts.onDelete,
    },
  ];
}

/** One template or preset card. The user's own items are fully editable; bundled ones offer only the copy-out in a release build and gain the repo-write actions in a dev checkout, which is exactly what `dev` carries. */
export function libraryCardMenuItems(opts: {
  kind: LibraryKind;
  source: LibrarySource;
  /** `isEditableProjectId`: the user's own items always, the bundled trees only from a dev checkout. */
  writable: boolean;
  onOpen: () => void;
  /** Templates only: seeds the new-project wizard with this template. */
  onNewProject?: () => void;
  onEditDetails: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}): (ContextMenuItem | "separator")[] {
  const mine = opts.source === "user";
  const writable = opts.writable;
  const noun = opts.kind === "template" ? "template" : "preset";
  const items: (ContextMenuItem | "separator")[] = [];

  if (writable) {
    items.push({
      id: "open",
      label: "Open",
      icon: <LibraryMenuIcon id="open" />,
      onSelect: opts.onOpen,
    });
  }
  if (opts.onNewProject) {
    items.push({
      id: "new-project",
      label: "New project from this…",
      icon: <LibraryMenuIcon id="new-project" />,
      onSelect: opts.onNewProject,
    });
  }
  if (writable) {
    items.push({
      id: "details",
      label: "Edit details…",
      icon: <LibraryMenuIcon id="details" />,
      onSelect: opts.onEditDetails,
    });
  }
  items.push({
    id: "duplicate",
    label: mine ? "Duplicate" : `Duplicate to my ${noun}s`,
    icon: mine ? <SceneMenuIcon id="duplicate" /> : <LibraryMenuIcon id="duplicate-to" />,
    onSelect: opts.onDuplicate,
  });
  if (writable) {
    items.push("separator", {
      id: "delete",
      label: "Delete…",
      icon: <SceneMenuIcon id="delete" />,
      confirmLabel: "Really delete?",
      danger: true,
      title: mine
        ? `Removes the ${noun} folder from your library`
        : `Removes the ${noun} folder from the checkout`,
      onSelect: opts.onDelete,
    });
  }
  return items;
}
