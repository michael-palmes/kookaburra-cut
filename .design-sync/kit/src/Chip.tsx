import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cx } from "./cx";

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Selected choice: accent border + `--accent-subtle` fill (the house selection pattern). */
  selected?: boolean;
}

/**
 * Pill-shaped compact action or choice (`chip`). Used for prompt templates, duration
 * presets and wizard choices. Selection is shown by the accent border + subtle fill,
 * never a full accent fill.
 */
export function Chip({ selected, className, ...rest }: ChipProps) {
  return (
    <button type="button" className={cx("chip", selected && "selected", className)} {...rest} />
  );
}

export type ChipRowProps = HTMLAttributes<HTMLDivElement>;

/** Wrapping flex row for chips (`chip-row`), hairline-divided from content below. */
export function ChipRow({ className, ...rest }: ChipRowProps) {
  return <div className={cx("chip-row", className)} {...rest} />;
}
