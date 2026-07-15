import type { ContextMenuItem } from "../ContextMenu";
import { hexToHslString, hexToRgbString } from "./colourUtils";

/** Right-click menu for any colour square: copy variants, plus Reset where the host provides one. */
export function colourSwatchMenu(opts: {
  hex: string;
  onReset?: () => void;
}): (ContextMenuItem | "separator")[] {
  const { hex, onReset } = opts;
  const items: (ContextMenuItem | "separator")[] = [
    {
      id: "copy-hex",
      label: "Copy hex",
      onSelect: () => void navigator.clipboard.writeText(hex),
    },
    {
      id: "copy-rgb",
      label: "Copy RGB",
      onSelect: () => void navigator.clipboard.writeText(hexToRgbString(hex)),
    },
    {
      id: "copy-hsl",
      label: "Copy HSL",
      onSelect: () => void navigator.clipboard.writeText(hexToHslString(hex)),
    },
  ];
  if (onReset) {
    items.push("separator", { id: "reset", label: "Reset to default", onSelect: onReset });
  }
  return items;
}
