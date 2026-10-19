import type { LoadedProject } from "../engine/project";
import { errorHeadline } from "../engine/sceneErrors";

const MAX_LINES = 6;

export function WarningIcon() {
  return (
    <svg
      className="load-notice-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 2.2 14.2 13H1.8Z" />
      <path d="M8 6.4v3" />
      <path d="M8 11.4h.01" />
    </svg>
  );
}

/** A persistent notice: danger for a stale stage, warning for a degraded load; never auto-dismissed. */
export function LoadNotice({
  tone,
  title,
  lines = [],
  hint,
  onDismiss,
  className,
}: {
  tone: "danger" | "warning";
  title: string;
  lines?: string[];
  hint?: string;
  onDismiss?: () => void;
  className?: string;
}) {
  const unique = [...new Set(lines)];
  const shown = unique.length > MAX_LINES ? unique.slice(0, MAX_LINES - 1) : unique;
  const more = unique.length - shown.length;
  return (
    <div
      className={`load-notice load-notice-${tone}${className ? ` ${className}` : ""}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      <WarningIcon />
      <div className="load-notice-body">
        <p className="load-notice-title">{title}</p>
        {shown.length > 0 && (
          <ul className="load-notice-list">
            {shown.map((line) => (
              <li key={line} title={line}>
                {line}
              </li>
            ))}
            {more > 0 && <li>and {more} more</li>}
          </ul>
        )}
        {hint && <p className="load-notice-hint">{hint}</p>}
      </div>
      {onDismiss && (
        <button type="button" className="toast-close" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
}

/** What a successful but degraded load should tell the user, or null when it loaded clean. */
export function degradedLoadNotice(
  project: LoadedProject,
): { key: string; title: string; lines: string[]; hint?: string } | null {
  const scenes = project.sceneErrors ?? [];
  const fonts = project.fontIssues ?? [];
  const warnings = project.loadWarnings ?? [];
  if (scenes.length + fonts.length + warnings.length === 0) return null;
  const lines = [
    ...scenes.map((e) => `${e.file}: ${errorHeadline(e.message)}`),
    ...fonts.map(
      (f) => `${f.ref}: ${errorHeadline(f.message)}${f.fallback ? ` (showing ${f.fallback})` : ""}`,
    ),
    ...warnings.map(errorHeadline),
  ];
  // Parse warnings never block export, so a load whose only problems are ignored settings says just that.
  const settingsOnly = (project.exportBlockers ?? []).length === 0;
  const title =
    scenes.length > 0
      ? scenes.length === 1
        ? "A scene can’t load"
        : `${scenes.length} scenes can’t load`
      : fonts.length > 0
        ? "Some fonts can’t be used here"
        : settingsOnly
          ? "Some settings were ignored"
          : "This project loaded with a problem";
  const hint =
    scenes.length > 0
      ? "They show an error card and export is off until they load. Fix the files, or ask Claude Code to."
      : fonts.length > 0
        ? "Those faces render in the stand-in shown. Pick another font, or ask Claude Code to."
        : settingsOnly
          ? "The project renders without them. Fix the files, or ask Claude Code to."
          : undefined;
  return { key: `${project.id}\n${lines.join("\n")}`, title, lines, hint };
}
