import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import {
  BLANK_TEMPLATE_ID,
  formatTemplateDuration,
  listTemplates,
  searchTemplates,
  TEMPLATE_CATEGORIES,
  TEMPLATE_PREVIEW_COUNT,
  TEMPLATE_USE_LABELS,
  type TemplateCategoryId,
  type TemplateEntry,
  templateCategoryCounts,
} from "../engine/templates";
import { listProjects, slugifyName } from "../engine/workspace";
import { builtinThemes, defaultTheme } from "../theme/registry";
import {
  builtinThemeChoices,
  listThemeChoices,
  recordSuccessfulThemeUse,
  ThemeBrowser,
  type ThemeChoice,
} from "./ThemePicker";
import { useEscapeClose } from "./useEscapeClose";

/** Setup-failure escape hatch, never seen on a healthy first run: the workspace is created silently at ~/Kookaburra Cut and only ever moved from Settings. This appears when that creation failed (unwritable home folder, full disk), so a blocked default is recoverable without a reinstall. (Default moved out of ~/Documents 2026-07-05: macOS TCC guards Documents and kept breaking headless gates and terminal-driven workflows.) */
export function SetupFailedDialog({
  error,
  onRetry,
  onChoose,
}: {
  error: string;
  onRetry: () => Promise<void>;
  onChoose: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const run = (action: () => Promise<void>) => async () => {
    setBusy(true);
    setRetryError(null);
    try {
      await action();
    } catch (e) {
      setRetryError(String(e));
      setBusy(false);
    }
  };
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Set up Kookaburra Cut"
    >
      <div className="modal">
        <h2>Kookaburra Cut could not set up your projects folder</h2>
        <p className="muted">
          It tried to create a <code>Kookaburra Cut</code> folder in your home folder. Try again, or
          pick somewhere else to keep your projects.
        </p>
        <p className="modal-error">{retryError ?? error}</p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={run(onChoose)} disabled={busy}>
            Choose folder…
          </button>
          <button type="button" className="btn primary" onClick={run(onRetry)} disabled={busy}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

/** F-001 trust gate: consent before a workspace project's scene code compiles. Escape declines, same as Don't open. */
export function TrustGateModal({
  name,
  onAnswer,
}: {
  name: string;
  onAnswer: (allowed: boolean) => void;
}) {
  useEscapeClose(() => onAnswer(false));
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Allow project ${name}?`}
    >
      <div className="modal">
        <h2>This project runs scene code on your Mac</h2>
        <p className="muted">
          Scenes in “{name}” are code that compiles and runs inside Kookaburra Cut, with the same
          access as the app itself. Only allow projects you trust.
        </p>
        <p className="muted">
          Your own edits stay trusted. If the project changes outside the app, you will be asked
          again. Allowing is consent, not a sandbox.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => onAnswer(false)}>
            Don't open
          </button>
          <button type="button" className="btn primary" onClick={() => onAnswer(true)}>
            Allow project
          </button>
        </div>
      </div>
    </div>
  );
}

/** Plain-English warning before the camera switches to Free, shown until the user ticks it away. Escape is Cancel, and the tick only sticks when the switch is confirmed. */
export function FreeCameraWarningModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: (dontShowAgain: boolean) => void;
  onCancel: () => void;
}) {
  const [dontShowAgain, setDontShowAgain] = useState(false);
  useEscapeClose(onCancel);
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Switch to Free camera?"
    >
      <div className="modal">
        <h2>Switch to Free camera?</h2>
        <p className="muted">
          Free mode unlocks the camera so you can fly it anywhere, like piloting a drone: you choose
          where it sits and where it looks. It is more powerful than Orbit, but it is easier to lose
          your framing.
        </p>
        <p className="muted">Your Orbit settings are kept, so you can switch back at any time.</p>
        <label className="modal-check">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
          />
          Don't show this again
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => onConfirm(dontShowAgain)}>
            Switch to Free
          </button>
        </div>
      </div>
    </div>
  );
}

/** Inline stroked glyphs (the exportIcons idiom: pure UI chrome, CSP allows no remote assets). */
function railIcon(children: ReactElement): ReactElement {
  return (
    <svg
      className="template-rail-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const CATEGORY_ICONS: Record<string, ReactElement> = {
  all: railIcon(
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>,
  ),
  "app-updates": railIcon(
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 16V8m0 0l-3.5 3.5M12 8l3.5 3.5" />
    </>,
  ),
  "product-launch": railIcon(
    <>
      <path d="M12 3c3 2 4.2 6 3 9.5L12 15.5 9 12.5C7.8 9 9 5 12 3z" />
      <path d="M9.5 12.5l-3 2.5 1 2.5 3-1.2M14.5 12.5l3 2.5-1 2.5-3-1.2M12 16v4" />
      <circle cx="12" cy="8.4" r="1.2" />
    </>,
  ),
  "marketing-social": railIcon(
    <>
      <path d="M18 5v14l-8-3.2H6.5A2.5 2.5 0 0 1 4 13.3v-2.6a2.5 2.5 0 0 1 2.5-2.5H10L18 5z" />
      <path d="M8 16v3.5" />
    </>,
  ),
  presentations: railIcon(
    <>
      <rect x="4" y="4.5" width="16" height="10.5" rx="1.5" />
      <path d="M12 15v3m-3.5 2l3.5-2 3.5 2" />
    </>,
  ),
  "finance-crypto": railIcon(
    <>
      <path d="M4 17l5-5 3 3 8-8" />
      <path d="M16 7h4v4" />
    </>,
  ),
  "ai-developer": railIcon(
    <>
      <path d="M5 7l5 5-5 5" />
      <path d="M12 17h7" />
    </>,
  ),
};

/** The chips a card flags itself with, in reading order. */
function cardFlags(entry: TemplateEntry): string[] {
  const flags: string[] = [];
  if (entry.status === "beta") flags.push("Beta");
  if (entry.level === "showcase") flags.push("Showcase");
  if (entry.storeLegal) flags.push("Store legal");
  return flags;
}

/** One template card: a `div role="radio"`, not a `<button>`, since WKWebView won't reliably paint an `<img>` child inside a real button (the MediaBrowser lesson, same as ThemeCard). Mouse X across the poster cycles the four committed stills; with none rendered yet the card falls back to the template theme's swatch at the same 16:9 box, so the grid never reflows when the art lands. */
function TemplateCard({
  entry,
  selected,
  tabStop,
  onSelect,
}: {
  entry: TemplateEntry;
  selected: boolean;
  /** The grid's single tab stop: the selection, or the first card when a filter hides it. */
  tabStop: boolean;
  onSelect: () => void;
}) {
  const [frame, setFrame] = useState(0);
  const thumbRef = useRef<HTMLDivElement>(null);
  const previews = entry.previews;
  const src = previews ? previews[Math.min(frame, previews.length - 1)] : null;
  const theme = builtinThemes[entry.themeId] ?? defaultTheme;
  const flags = cardFlags(entry);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a real <button> drops the img in WKWebView
    <div
      role="radio"
      data-template-id={entry.id}
      tabIndex={tabStop ? 0 : -1}
      aria-checked={selected}
      className={`template-card${selected ? " selected" : ""}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover-only preview cycling, the parent card carries the interactive semantics */}
      <div
        ref={thumbRef}
        className="template-card-thumb"
        onMouseMove={(e) => {
          if (!previews || !thumbRef.current) return;
          const rect = thumbRef.current.getBoundingClientRect();
          const t = (e.clientX - rect.left) / Math.max(1, rect.width);
          setFrame(
            Math.min(TEMPLATE_PREVIEW_COUNT - 1, Math.max(0, Math.floor(t * previews.length))),
          );
        }}
        onMouseLeave={() => setFrame(0)}
      >
        {src ? (
          <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />
        ) : (
          <div className="template-card-swatch" style={{ background: theme.colors.background }}>
            <span style={{ color: theme.colors.text }}>Aa</span>
            <span className="template-card-accent" style={{ background: theme.colors.accent }} />
          </div>
        )}
      </div>
      <div className="template-card-body">
        <span className="template-card-name">{entry.name}</span>
        <p className="template-card-tagline">{entry.tagline}</p>
        <span className="template-card-meta">
          {`${entry.sceneCount} ${entry.sceneCount === 1 ? "scene" : "scenes"} · ${formatTemplateDuration(entry.durationMs)} · ${entry.primaryAspect}`}
        </span>
        {(entry.uses.length > 0 || flags.length > 0) && (
          <span className="template-card-chips">
            {entry.uses.slice(0, 2).map((use) => (
              <span key={use} className="template-chip">
                {TEMPLATE_USE_LABELS[use]}
              </span>
            ))}
            {flags.map((flag) => (
              <span key={flag} className="template-chip flag">
                {flag}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

/** The template browser: a category rail with live counts, a global search, the one v1 facet chip (tier) and a scrolling card grid. Blank is pinned first in every view rather than sitting in a category, and is the default selection so Enter-to-create still works. Filtering is `searchTemplates`, a pure function in the registry, so the rules are unit-tested without rendering. */
function TemplateGallery({
  value,
  onChange,
  query,
  onQueryChange,
}: {
  value: string;
  onChange: (id: string) => void;
  /** Owned by the dialog so Escape can clear the search before it closes the modal. */
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const entries = useMemo(() => listTemplates(), []);
  const [category, setCategory] = useState<TemplateCategoryId | null>(null);
  const [stashedCategory, setStashedCategory] = useState<TemplateCategoryId | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const railRef = useRef<HTMLFieldSetElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const counts = useMemo(() => templateCategoryCounts(entries, { query }), [entries, query]);
  const visible = useMemo(
    () => searchTemplates(entries, { query, category }),
    [entries, query, category],
  );
  const tabStopId = visible.some((entry) => entry.id === value) ? value : visible[0]?.id;

  // "/" reaches the search from anywhere in the dialog, the Welcome-search precedent, unless the user is already typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Search is global: it switches the rail to All and offers the category back as a chip.
  const onQuery = (next: string) => {
    if (next && category) {
      setStashedCategory(category);
      setCategory(null);
    }
    onQueryChange(next);
  };
  useEffect(() => {
    if (!query) setStashedCategory(null);
  }, [query]);
  const clearFilters = () => {
    onQueryChange("");
    setCategory(null);
    setStashedCategory(null);
  };
  const pickCategory = (next: TemplateCategoryId | null) => {
    setCategory(next);
    setStashedCategory(null);
  };

  const cards = () =>
    Array.from(gridRef.current?.querySelectorAll<HTMLElement>(".template-card") ?? []);
  const columnCount = () => {
    const all = cards();
    if (all.length === 0) return 1;
    const top = all[0].offsetTop;
    let columns = 0;
    for (const card of all) {
      if (card.offsetTop !== top) break;
      columns += 1;
    }
    return Math.max(1, columns);
  };
  const moveTo = (index: number) => {
    const entry = visible[Math.min(visible.length - 1, Math.max(0, index))];
    if (!entry) return;
    onChange(entry.id);
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-template-id="${entry.id}"]`);
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  };
  const NAV_KEYS = [
    "ArrowRight",
    "ArrowLeft",
    "ArrowDown",
    "ArrowUp",
    "Home",
    "End",
    "PageDown",
    "PageUp",
  ];
  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (!NAV_KEYS.includes(e.key)) return;
    e.preventDefault();
    // A filter can hide the selection, in which case every move starts at the first card.
    const anchor = visible.findIndex((entry) => entry.id === value);
    if (anchor < 0) {
      moveTo(0);
      return;
    }
    const columns = columnCount();
    const row = Math.floor(anchor / columns);
    if (e.key === "ArrowRight") moveTo(anchor + 1);
    else if (e.key === "ArrowLeft") moveTo(anchor - 1);
    else if (e.key === "ArrowDown") moveTo(anchor + columns);
    else if (e.key === "ArrowUp") moveTo(anchor - columns);
    else if (e.key === "Home") moveTo(e.metaKey ? 0 : row * columns);
    else if (e.key === "End") moveTo(e.metaKey ? visible.length - 1 : row * columns + columns - 1);
    else {
      const card = cards()[0];
      const page = card
        ? Math.max(1, Math.floor((gridRef.current?.clientHeight ?? 0) / card.offsetHeight))
        : 1;
      moveTo(anchor + (e.key === "PageDown" ? 1 : -1) * page * columns);
    }
  };

  const railRows: { id: TemplateCategoryId | null; label: string; count: number }[] = [
    { id: null, label: "All", count: counts.all },
    ...TEMPLATE_CATEGORIES.map((c) => ({
      id: c.id as TemplateCategoryId,
      label: c.label,
      count: counts.byCategory[c.id],
    })),
  ];
  const onRailKeyDown = (e: React.KeyboardEvent) => {
    const enabled = railRows.filter((r) => r.id === null || r.count > 0);
    if (enabled.length === 0) return;
    const current = Math.max(
      0,
      enabled.findIndex((r) => r.id === category),
    );
    let next = current;
    if (e.key === "ArrowDown") next = Math.min(enabled.length - 1, current + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = enabled.length - 1;
    else return;
    e.preventDefault();
    const row = enabled[next];
    pickCategory(row.id);
    railRef.current
      ?.querySelectorAll<HTMLElement>(".template-rail-row")
      [railRows.findIndex((r) => r.id === row.id)]?.focus();
  };

  return (
    <div className="template-gallery">
      <div className="template-gallery-bar">
        <input
          ref={searchRef}
          className="modal-input template-gallery-search"
          type="search"
          placeholder="Search templates…"
          aria-label="Search templates"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <span className="template-gallery-count" aria-live="polite">
          {`${visible.length} ${visible.length === 1 ? "template" : "templates"}`}
        </span>
      </div>
      <div className="template-gallery-body">
        <fieldset
          ref={railRef}
          className="template-rail"
          aria-label="Template categories"
          onKeyDown={onRailKeyDown}
        >
          {railRows.map((row) => (
            <button
              key={row.id ?? "all"}
              type="button"
              className={`template-rail-row${category === row.id ? " selected" : ""}`}
              aria-pressed={category === row.id}
              tabIndex={category === row.id ? 0 : -1}
              disabled={row.id !== null && row.count === 0}
              onClick={() => pickCategory(row.id)}
            >
              {CATEGORY_ICONS[row.id ?? "all"]}
              <span className="template-rail-label">{row.label}</span>
              <span className="template-rail-count">{row.count}</span>
            </button>
          ))}
        </fieldset>
        <div className="template-gallery-results">
          {stashedCategory && (
            <div className="template-gallery-restore">
              <button
                type="button"
                className="template-facet"
                onClick={() => {
                  pickCategory(stashedCategory);
                  onQueryChange("");
                }}
              >
                {`Back to ${TEMPLATE_CATEGORIES.find((c) => c.id === stashedCategory)?.label}`}
              </button>
            </div>
          )}
          {visible.length === 0 ? (
            <div className="template-empty">
              <p>
                {query ? `No templates match “${query}”.` : "No templates match these filters."}
              </p>
              <button type="button" className="btn" onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          ) : (
            <div
              ref={gridRef}
              className="template-grid"
              role="radiogroup"
              aria-label="Starting template"
              onKeyDown={onGridKeyDown}
            >
              {visible.map((entry) => (
                <TemplateCard
                  key={entry.id}
                  entry={entry}
                  selected={value === entry.id}
                  tabStop={entry.id === tabStopId}
                  onSelect={() => onChange(entry.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Create-project dialog: the template browser + name, then the theme grid with hover-cycled previews. The theme applies to the new project's `project.json` after the template copy (`set_project_theme`). */
export function NewProjectDialog({
  initialGroup,
  onCreate,
  onCancel,
}: {
  /** Preselected welcome-screen group (from a group heading's "+"). */
  initialGroup?: string | null;
  onCreate: (
    name: string,
    templateId: string,
    themeId: string,
    group: string | null,
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<"details" | "theme">("details");
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState<string>(BLANK_TEMPLATE_ID);
  const [themeId, setThemeId] = useState("kookaburra-studio-white");
  const [themes, setThemes] = useState<ThemeChoice[]>(builtinThemeChoices);
  const [group, setGroup] = useState(initialGroup ?? "");
  const [groups, setGroups] = useState<string[]>([]);
  const [templateQuery, setTemplateQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = slugifyName(name);
  // Escape clears an active template search first, then closes.
  useEscapeClose(() => {
    if (step === "details" && templateQuery) {
      setTemplateQuery("");
      return;
    }
    onCancel();
  }, !busy);
  // Bundled choices resolve synchronously inside; workspace themes join when listed.
  useEffect(() => {
    let cancelled = false;
    void listThemeChoices().then((choices) => {
      if (!cancelled) setThemes(choices);
    });
    void listProjects()
      .then((list) => {
        if (cancelled) return;
        const names = Array.from(
          new Set(list.map((p) => p.group).filter((g): g is string => Boolean(g))),
        ).sort((a, b) => a.localeCompare(b));
        setGroups(names);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const next = () => {
    if (!slug) {
      setError("Give the project a name.");
      return;
    }
    setError(null);
    setStep("theme");
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await recordSuccessfulThemeUse(themeId, () =>
        onCreate(name, templateId, themeId, group.trim() || null),
      );
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="New project">
      <div
        className={`modal wizard-wide${step === "details" ? " wizard-template-wide" : " wizard-theme-wide"}`}
      >
        <h2>New project</h2>
        {step === "details" && (
          <>
            <TemplateGallery
              value={templateId}
              onChange={setTemplateId}
              query={templateQuery}
              onQueryChange={setTemplateQuery}
            />
            <div className="wizard-detail-card">
              <input
                className="modal-input wizard-name-input"
                type="text"
                placeholder="Project name"
                value={name}
                // biome-ignore lint/a11y/noAutofocus: naming is the one thing the dialog always needs typed; "/" reaches the template search
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") next();
                }}
              />
              <p className="modal-hint">
                {slug ? `Saved as ${slug}` : "Pick a template, then name your project."}
              </p>
              <div className="wizard-group-row">
                <svg
                  className="template-rail-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v8A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17V7z" />
                </svg>
                <span className="wizard-label">Group</span>
                {groups.length > 0 && (
                  <fieldset className="group-chips" aria-label="Existing groups">
                    {groups.map((g) => (
                      <button
                        key={g}
                        type="button"
                        className={`group-chip${group.trim() === g ? " selected" : ""}`}
                        onClick={() => setGroup(group.trim() === g ? "" : g)}
                      >
                        {g}
                      </button>
                    ))}
                  </fieldset>
                )}
                <input
                  className="modal-input wizard-group-input"
                  type="text"
                  placeholder="No group"
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                />
              </div>
            </div>
            {error && <p className="modal-error">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn primary" onClick={next} disabled={busy}>
                Next
              </button>
            </div>
          </>
        )}
        {step === "theme" && (
          <>
            <p className="modal-hint">
              Pick the project's theme — hover a card to preview its four scenes. You can change it
              later, per project or per scene.
            </p>
            <ThemeBrowser choices={themes} value={themeId} onChange={setThemeId} />
            {error && <p className="modal-error">{error}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setStep("details")}
                disabled={busy}
              >
                Back
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void submit()}
                disabled={busy}
              >
                {busy ? "Creating…" : "Create"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
