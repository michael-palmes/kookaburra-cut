import { openEdit, openEditNamed } from "../engine/edit";
import { copyToGlobalScreenshots, deleteMedia, type MediaMeta } from "../engine/media";
import type { ContextMenuItem } from "./ContextMenu";
import type { MediaActionContext } from "./MediaBrowser";

/** The media-card ⋯/right-click menu (2026-07-12): shared by the media library, the Project-tab media drill-in and the Background ▸ Video picker. Edit opens the video editor (a rendered output reopens its own edit; videos only); the primary action is the host's ("Insert" pastes into Claude, "Select" picks); Delete is the house two-step to the Trash (refused while a scene still references the file). Rename is deliberately absent for now (Michael's call). */
export function mediaCardMenu(opts: {
  slug: string;
  /** The non-destructive primary action's label ("Insert" | "Select"). */
  primaryLabel: string;
  onPrimary: (rel: string, meta: MediaMeta | null) => void;
  /** A delete landed, re-scan the grid. */
  onChanged: () => void;
  /** Edit/Delete failures must never be silent; null clears. */
  onError: (message: string | null) => void;
  /** Scene-surface override: return true to claim the Edit action (arms the auto re-point); false falls through to the plain library open. */
  onEdit?: (rel: string) => boolean;
}): (rel: string, meta: MediaMeta | null, ctx: MediaActionContext) => ContextMenuItem[] {
  return (rel, meta, ctx) => {
    const items: ContextMenuItem[] = [];
    if (meta?.kind === "video") {
      items.push({
        id: "edit",
        label: ctx.editedOf ? "Open in editor" : "Edit",
        onSelect: () => {
          opts.onError(null);
          if (opts.onEdit?.(rel)) return;
          const opening = ctx.editedOf
            ? openEditNamed(opts.slug, ctx.editedOf)
            : openEdit(opts.slug, rel);
          opening.catch((e) => {
            console.warn(`[media] open editor failed for ${rel}:`, e);
            opts.onError(`Couldn't open the editor: ${String(e)}`);
          });
        },
      });
    }
    items.push(
      {
        id: "primary",
        label: opts.primaryLabel,
        onSelect: () => opts.onPrimary(rel, meta),
      },
      {
        id: "add-global",
        label: "Add to library",
        title: "Copy this file into your media library for reuse in any project",
        onSelect: () => {
          opts.onError(null);
          copyToGlobalScreenshots(opts.slug, rel).catch((e) => opts.onError(String(e)));
        },
      },
      {
        id: "delete",
        label: "Delete",
        confirmLabel: "Really delete?",
        danger: true,
        title: "Moves the file to the Trash (refused while a scene still uses it)",
        onSelect: () => {
          opts.onError(null);
          deleteMedia(opts.slug, rel)
            .then(opts.onChanged)
            .catch((e) => opts.onError(String(e)));
        },
      },
    );
    return items;
  };
}
