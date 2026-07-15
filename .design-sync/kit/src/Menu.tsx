import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cx } from "./cx";

export type MenuProps = HTMLAttributes<HTMLDivElement>;

/**
 * Dropdown action menu (`rail-menu`): an elevated panel of MenuItems. Positions itself
 * absolutely below its trigger — wrap trigger + Menu in a relatively-positioned host
 * (the app uses `rail-more`).
 */
export function Menu({ className, ...rest }: MenuProps) {
  return <div className={cx("rail-menu", className)} role="menu" {...rest} />;
}

export type MenuItemProps = ButtonHTMLAttributes<HTMLButtonElement>;

/** One row in a Menu (`rail-menu-item`): quiet at rest, raised fill on hover. */
export function MenuItem({ className, ...rest }: MenuItemProps) {
  return (
    <button type="button" role="menuitem" className={cx("rail-menu-item", className)} {...rest} />
  );
}
