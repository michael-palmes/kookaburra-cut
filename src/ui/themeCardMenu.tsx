import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useState } from "react";
import { WORKSPACE_THEME_PREFIX } from "../theme/registry";
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from "./ContextMenu";
import { NamePromptModal } from "./NamePromptModal";
import type { ThemeChoice } from "./ThemePicker";

/** Theme-card right-click menu, shared by the project- and scene-theme drill-ins: workspace themes get Apply/Edit fonts/Edit in Claude Code/Rename/Delete, read-only built-ins get Apply/Duplicate…; Rename only touches the theme JSON's `name` field, never the slug folder. */
export function useThemeCardMenu(opts: {
  /** Apply the theme in the host's sense (project apply vs scene override). */
  onApply: (themeId: string) => void;
  /** Open the ThemeMode modal on a specific pane (fonts / duplicate) for this theme. */
  onManage: (manage: { view: "fonts" | "duplicate"; themeId: string }) => void;
  /** Paste a starter prompt into the Claude session (the media Insert pattern). */
  onEditInClaude: (choice: ThemeChoice) => void;
  /** A ws theme's JSON changed; the App regenerates previews / reloads if in use. */
  onThemeEdited: (wsId: string, json: string) => Promise<void>;
  /** Rename/delete landed; re-list the choices. */
  onChanged: () => void;
}): {
  openMenu: (choice: ThemeChoice, e: React.MouseEvent) => void;
  menuElement: ReactNode;
} {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<ThemeChoice | null>(null);

  const openMenu = (choice: ThemeChoice, e: React.MouseEvent) => {
    e.preventDefault();
    const isWs = choice.id.startsWith(WORKSPACE_THEME_PREFIX);
    const slug = choice.id.slice(WORKSPACE_THEME_PREFIX.length);
    const items: (ContextMenuItem | "separator")[] = [
      { id: "apply", label: "Apply", onSelect: () => opts.onApply(choice.id) },
    ];
    if (isWs) {
      items.push(
        {
          id: "fonts",
          label: "Edit fonts…",
          onSelect: () => opts.onManage({ view: "fonts", themeId: choice.id }),
        },
        {
          id: "claude",
          label: "Edit in Claude Code",
          onSelect: () => opts.onEditInClaude(choice),
        },
        "separator",
        { id: "rename", label: "Rename…", onSelect: () => setRenaming(choice) },
        {
          id: "delete",
          label: "Delete",
          confirmLabel: "Really delete?",
          danger: true,
          onSelect: () => {
            void invoke("delete_theme", { slug })
              .then(opts.onChanged)
              .catch((err) => console.warn("[theme] delete failed:", err));
          },
        },
      );
    } else {
      items.push({
        id: "duplicate",
        label: "Duplicate…",
        onSelect: () => opts.onManage({ view: "duplicate", themeId: choice.id }),
      });
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
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
          hint="Renames the theme everywhere it's listed — its folder on disk keeps its slug."
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
