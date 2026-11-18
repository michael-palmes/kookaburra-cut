import type { ContextMenuItem } from "./ContextMenu";
import { SceneMenuIcon } from "./sceneMenu";

/** Move up and Move down for a reorderable menu: each runs the same reorder its drag commits. A null action shows the item disabled, with `upTitle` or `downTitle` saying why. */
export interface MenuMoves {
  up: (() => void) | null;
  down: (() => void) | null;
  upTitle?: string;
  downTitle?: string;
}

export function moveMenuItems(moves: MenuMoves): ContextMenuItem[] {
  return [
    {
      id: "move-up",
      label: "Move up",
      icon: <SceneMenuIcon id="move-up" />,
      disabled: moves.up === null,
      title: moves.up === null ? (moves.upTitle ?? "Already first") : undefined,
      onSelect: () => moves.up?.(),
    },
    {
      id: "move-down",
      label: "Move down",
      icon: <SceneMenuIcon id="move-down" />,
      disabled: moves.down === null,
      title: moves.down === null ? (moves.downTitle ?? "Already last") : undefined,
      onSelect: () => moves.down?.(),
    },
  ];
}
