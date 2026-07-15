import type { ReactNode } from "react";
import { cx } from "./cx";

export interface TitlebarProps {
  /** Project name (semibold, ellipsised). */
  title: string;
  /** Display path stacked under the name (the v13 identity block). Absent = plain title. */
  subtitle?: string;
  /** Right-aligned global actions after the flexible spacer (Export is the only accent). */
  children?: ReactNode;
  className?: string;
}

/**
 * Custom macOS titlebar (`titlebar`, 46px, v13): the left ~78px stays clear for the
 * traffic lights; the project identity leads as name-over-path; global actions
 * right-align after `spacer`, with Export as the ONLY accent control. In the app the
 * background is the draggable region and every child is no-drag.
 */
export function Titlebar({ title, subtitle, children, className }: TitlebarProps) {
  return (
    <header className={cx("titlebar", className)}>
      {subtitle ? (
        <div className="titlebar-identity">
          <span className="titlebar-name">{title}</span>
          <span className="titlebar-path">{subtitle}</span>
        </div>
      ) : (
        <span className="titlebar-title">{title}</span>
      )}
      <span className="spacer" />
      {children}
    </header>
  );
}
