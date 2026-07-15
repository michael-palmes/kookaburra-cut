import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The single accent-filled primary action (`btn primary`) — at most one per surface. */
  primary?: boolean;
  /** Compact 22px control (`btn btn-small`) for dense rows: rail actions, edit bars. */
  small?: boolean;
}

/**
 * Neutral raised button — the default control. Flat `--surface-raised` fill with a
 * 1px border; `primary` swaps to the buff-gold accent with near-black text. Never place
 * two primary buttons on one surface.
 */
export function Button({ primary, small, className, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={cx("btn", small && "btn-small", primary && "primary", className)}
      {...rest}
    />
  );
}
