import type { ReactNode } from "react";
import { cx } from "./cx";

export interface SettingsRowProps {
  /** Semibold row title. */
  title: string;
  /** Tertiary detail line under the title (paths, current values — tabular numerics). */
  detail?: string;
  /** Trailing control(s): a Button, Select or toggle aligned to the row's end. */
  children?: ReactNode;
  className?: string;
}

/**
 * Settings/preferences row (`settings-row`): title + detail on the left, the control on
 * the right, on a bordered `--surface-panel` card. Stacks with 6px gaps.
 */
export function SettingsRow({ title, detail, children, className }: SettingsRowProps) {
  return (
    <div className={cx("settings-row", className)}>
      <div className="settings-row-text">
        <span className="settings-row-title">{title}</span>
        {detail ? <span className="settings-row-detail muted">{detail}</span> : null}
      </div>
      {children}
    </div>
  );
}
