import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cx } from "./cx";

export type MenuProps = HTMLAttributes<HTMLDivElement>;

/**
 * Dropdown action menu (`dropdown-menu`): an elevated panel of MenuItems. Positions itself
 * absolutely below its trigger — wrap trigger + Menu in a relatively-positioned host
 * (`dropdown-host`).
 */
export function Menu({ className, ...rest }: MenuProps) {
  return <div className={cx("dropdown-menu", className)} role="menu" {...rest} />;
}

export type MenuItemProps = ButtonHTMLAttributes<HTMLButtonElement>;

/** One row in a Menu (`dropdown-item`): quiet at rest, raised fill on hover. */
export function MenuItem({ className, ...rest }: MenuItemProps) {
  return (
    <button type="button" role="menuitem" className={cx("dropdown-item", className)} {...rest} />
  );
}
