import type { SelectHTMLAttributes } from "react";
import { cx } from "./cx";

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

/**
 * Native select styled as a raised control (`select`) — same tier as Button. Pass
 * `<option>` children. Used for codec, aspect and theme pickers.
 */
export function Select({ className, ...rest }: SelectProps) {
  return <select className={cx("select", className)} {...rest} />;
}
