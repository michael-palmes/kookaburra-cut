import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useState } from "react";
import { devDeleteBuiltinTheme } from "../engine/library";
import { WORKSPACE_THEME_PREFIX } from "../theme/registry";
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from "./ContextMenu";
import { NamePromptModal } from "./NamePromptModal";
import { SceneMenuIcon } from "./sceneMenu";
import type { ThemeChoice } from "./ThemePicker";
import { ThemeEditorIcon, type ThemeEditorIconName } from "./theme-editor/icons";
import { canEditBundledThemes, openThemeEditor } from "./theme-editor/themeEditorIo";

export interface ThemeCardMenuOptions {
  /** Apply the theme in the host's sense (project apply vs scene override). */
  onApply?: (themeId: string) => void;
  /** Open the ThemeMode modal on a specific pane (fonts / duplicate) for this theme. */
  onManage: (manage: { view: "fonts" | "duplicate"; themeId: string }) => void;
  /** Paste a starter prompt into the Claude session (the media Insert pattern). */
  onEditInClaude?: (choice: ThemeChoice) => void;
  /** A ws theme's JSON changed; the App regenerates previews / reloads if in use. */
  onThemeEdited: (wsId: string, json: string) => Promise<void>;
  /** Rename/delete landed; re-list the choices. */
  onChanged: () => void;
  onError?: (message: string) => void;
}

export function buildThemeCardMenu(
  choice: ThemeChoice,
  opts: ThemeCardMenuOptions,
  onRename: (choice: ThemeChoice) => void,
  dev = canEditBundledThemes,
): (ContextMenuItem | "separator")[] {
  const isWs = choice.id.startsWith(WORKSPACE_THEME_PREFIX);
  const slug = choice.id.slice(WORKSPACE_THEME_PREFIX.length);
  const items: (ContextMenuItem | "separator")[] = [];
  if (opts.onApply)
    items.push({ id: "apply", label: "Apply", onSelect: () => opts.onApply?.(choice.id) });
  items.push({
    id: "duplicate",
    label: "Duplicate…",
    onSelect: () => opts.onManage({ view: "duplicate", themeId: choice.id }),
  });
  // Bundled themes only open in a checkout: a release build has no repo-write command to save them with.
  if (isWs || dev) {
    items.push({
      id: "edit",
      label: "Edit…",
      onSelect: () => {
        void openThemeEditor(choice.id).catch((err) =>
          (opts.onError ?? console.warn)(`Opening the theme editor failed: ${String(err)}`),
        );
      },
    });
  }
  if (isWs) {
    items.push(
      {
        id: "fonts",
        label: "Edit fonts…",
        onSelect: () => opts.onManage({ view: "fonts", themeId: choice.id }),
      },
      ...(opts.onEditInClaude
        ? [
            {
              id: "claude",
              label: "Edit in Claude Code",
              onSelect: () => opts.onEditInClaude?.(choice),
            },
          ]
        : []),
      "separator",
      { id: "rename", label: "Rename…", onSelect: () => onRename(choice) },
      {
        id: "delete",
        label: "Delete",
        confirmLabel: "Really delete?",
        danger: true,
        onSelect: () => {
          void invoke("delete_theme", { slug })
            .then(opts.onChanged)
            .catch((err) =>
              (opts.onError ?? console.warn)(`Deleting the theme failed: ${String(err)}`),
            );
        },
      },
    );
  } else {
    // A checkout deletes the bundled JSON for real (locked answer 19); projects pointing at it fall back to kookaburra-default, which is the existing behaviour for any unknown id.
    if (dev) {
      items.push("separator", {
        id: "delete-builtin",
        label: "Delete built-in…",
        confirmLabel: "Delete from the repo?",
        danger: true,
        onSelect: () => {
          void devDeleteBuiltinTheme(choice.id)
            .then(opts.onChanged)
            .catch((err) =>
              (opts.onError ?? console.warn)(`Deleting the built-in theme failed: ${String(err)}`),
            );
        },
      });
    }
  }
  const icons: Record<string, ThemeEditorIconName> = {
    apply: "save",
    edit: "identity",
    fonts: "typography",
    claude: "specimen",
    rename: "label",
  };
  for (const item of items) {
    if (item === "separator") continue;
    item.icon = item.id.startsWith("delete") ? (
      <SceneMenuIcon id="delete" />
    ) : item.id === "duplicate" ? (
      <SceneMenuIcon id="duplicate" />
    ) : (
      <ThemeEditorIcon name={icons[item.id] ?? "colours"} />
    );
  }
  return items;
}

export function useThemeCardMenu(opts: ThemeCardMenuOptions): {
  openMenu: (choice: ThemeChoice, e: React.MouseEvent) => void;
  menuElement: ReactNode;
} {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<ThemeChoice | null>(null);
  const openMenu = (choice: ThemeChoice, event: React.MouseEvent) => {
    event.preventDefault();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: buildThemeCardMenu(choice, opts, setRenaming),
      returnFocus: event.currentTarget as HTMLElement,
    });
  };

  const menuElement = (
    <>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {renaming && (
        <NamePromptModal
          title="Rename theme"
          label="Theme name"
          initial={renaming.name}
          submitLabel="Rename"
          hint="Renames the theme everywhere it is listed. Its folder keeps its slug."
          onCancel={() => setRenaming(null)}
          onSubmit={async (name) => {
            const slug = renaming.id.slice(WORKSPACE_THEME_PREFIX.length);
            const raw = JSON.parse(await invoke<string>("read_theme", { slug }));
            raw.name = name;
            const json = JSON.stringify(raw, null, 2);
            await invoke("write_theme", { slug, text: json });
            await opts.onThemeEdited(renaming.id, json);
            setRenaming(null);
            opts.onChanged();
          }}
        />
      )}
    </>
  );

  return { openMenu, menuElement };
}
