import {
  type ReactElement,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { nameCollision, nameCollisionWarning } from "../engine/nameCollision";
import {
  BLANK_TEMPLATE_ID,
  listAllTemplates,
  refreshUserTemplates,
  searchTemplates,
  subscribeTemplates,
  TEMPLATE_CATEGORIES,
  type TemplateCategoryId,
  templateCategoryCounts,
} from "../engine/templates";
import { listProjects, slugifyName } from "../engine/workspace";
import {
  LibraryRailIcon,
  railIcon,
  TEMPLATE_CATEGORY_ICONS,
  THEME_CATEGORY_ICONS,
} from "./libraryIcons";
import {
  CLAUDE_START_ID,
  claudeStartMatches,
  DEFAULT_THEME_ID,
  defaultProjectName,
  initialLookThemeId,
  type LookFilter,
  lookChoices,
  startGridStep,
} from "./newProjectFlow";
import { ClaudeComposerArt, ClaudeSpark } from "./startArt";
import { cardRoleProps, TemplateCard } from "./TemplateCard";
import {
  builtinThemeChoices,
  filterThemeChoices,
  listThemeChoices,
  recordSuccessfulThemeUse,
  type ThemeChoice,
  ThemeGrid,
} from "./ThemePicker";
import { useEscapeClose } from "./useEscapeClose";

type Step = "start" | "look" | "name";

const STEPS: { id: Step; label: string; title: string }[] = [
  { id: "start", label: "Start", title: "How do you want to start?" },
  { id: "look", label: "Look", title: "Pick a look" },
  { id: "name", label: "Name", title: "Name" },
];

const MINE_CHIP = "mine";
type StartChip = TemplateCategoryId | typeof MINE_CHIP | null;

const SEARCH_ICON = railIcon(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </>,
);

const CHECK_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
    <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const LOOK_FILTERS: { id: LookFilter; label: string; icon: ReactElement }[] = [
  { id: "all", label: "All", icon: THEME_CATEGORY_ICONS.all },
  { id: "yours", label: "Yours", icon: THEME_CATEGORY_ICONS["my-themes"] },
  {
    id: "light",
    label: "Light",
    icon: railIcon(
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
      </>,
    ),
  },
  {
    id: "dark",
    label: "Dark",
    icon: railIcon(<path d="M19.5 14.5A8 8 0 1 1 9.5 4.5a6.5 6.5 0 0 0 10 10z" />),
  },
];

/** "/" reaches the step's search from anywhere in the dialog, unless the user is already typing. */
function useSlashFocus(ref: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      e.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ref]);
}

function SearchField({
  inputRef,
  label,
  value,
  onChange,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="new-project-search">
      <input
        ref={inputRef}
        className="modal-input"
        type="search"
        placeholder="Search"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {SEARCH_ICON}
    </div>
  );
}

function FilterChips<T extends string | null>({
  label,
  chips,
  value,
  onChange,
}: {
  label: string;
  chips: { id: T; label: string; icon: ReactElement }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <fieldset className="new-project-chips" aria-label={label}>
      {chips.map((chip) => (
        <button
          key={chip.id ?? "all"}
          type="button"
          className={`chip${value === chip.id ? " selected" : ""}`}
          aria-pressed={value === chip.id}
          onClick={() => onChange(chip.id)}
        >
          {chip.icon}
          {chip.label}
        </button>
      ))}
    </fieldset>
  );
}

function ClaudeStartCard({
  selected,
  tabStop,
  onSelect,
}: {
  selected: boolean;
  tabStop: boolean;
  onSelect: () => void;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the role rides in cardRoleProps, the TemplateCard pattern
    <div
      {...cardRoleProps(true, selected)}
      data-template-id={CLAUDE_START_ID}
      tabIndex={tabStop ? 0 : -1}
      className={`template-card claude-start${selected ? " selected" : ""}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="template-card-thumb claude-start-art">
        <ClaudeComposerArt />
        <span className="claude-start-badge">
          <ClaudeSpark />
          Recommended
        </span>
      </div>
      <div className="template-card-row">
        <span className="template-card-name">
          <ClaudeSpark />
          Create with Claude
        </span>
        <span className="template-card-meta">Describe it. Claude builds it.</span>
      </div>
    </div>
  );
}

/** Step one: Create with Claude, recommended and first, then the template catalogue behind category chips and a search. The blank template sits behind the Claude card, so it is not listed on its own. */
function StartGallery({
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
  const entries = useSyncExternalStore(subscribeTemplates, listAllTemplates);
  const [chip, setChip] = useState<StartChip>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  useSlashFocus(searchRef);
  // The workspace half lands behind the bundled catalogue, which renders on the first frame.
  useEffect(() => {
    refreshUserTemplates().catch((e) => setLibraryError(String(e)));
  }, []);
  const counts = useMemo(() => templateCategoryCounts(entries), [entries]);
  const mineCount = useMemo(() => searchTemplates(entries, { source: "user" }).length, [entries]);
  const templates = useMemo(
    () =>
      (chip === MINE_CHIP
        ? searchTemplates(entries, { query, source: "user" })
        : searchTemplates(entries, { query, category: chip })
      ).filter((entry) => entry.id !== BLANK_TEMPLATE_ID),
    [entries, query, chip],
  );
  const withClaude = chip === null && claudeStartMatches(query);
  const ids = [...(withClaude ? [CLAUDE_START_ID] : []), ...templates.map((entry) => entry.id)];
  const tabStopId = ids.includes(value) ? value : ids[0];

  const chips: { id: StartChip; label: string; icon: ReactElement }[] = [
    { id: null, label: "All", icon: TEMPLATE_CATEGORY_ICONS.all },
    ...TEMPLATE_CATEGORIES.filter((c) => counts.byCategory[c.id] > 0).map((c) => ({
      id: c.id as StartChip,
      label: c.label,
      icon: TEMPLATE_CATEGORY_ICONS[c.id],
    })),
    ...(mineCount > 0
      ? [{ id: MINE_CHIP as StartChip, label: "My templates", icon: TEMPLATE_CATEGORY_ICONS.mine }]
      : []),
  ];

  // Search is global: typing switches the chips back to All.
  const onQuery = (next: string) => {
    if (next && chip) setChip(null);
    onQueryChange(next);
  };

  const moveTo = (index: number) => {
    const id = ids[index];
    if (!id) return;
    onChange(id);
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-template-id="${id}"]`);
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  };
  const onGridKeyDown = (e: React.KeyboardEvent) => {
    const next = startGridStep(e.key, ids.indexOf(value), ids.length, withClaude, e.metaKey);
    if (next === null) return;
    e.preventDefault();
    moveTo(next);
  };

  return (
    <div className="new-project-step">
      {libraryError && (
        <p className="modal-error" role="alert">
          {libraryError}
        </p>
      )}
      <div className="new-project-filter">
        <FilterChips label="Template categories" chips={chips} value={chip} onChange={setChip} />
        <SearchField
          inputRef={searchRef}
          label="Search templates"
          value={query}
          onChange={onQuery}
        />
      </div>
      {ids.length === 0 ? (
        <div className="template-empty new-project-empty">
          <p>{query ? `No templates match “${query}”.` : "No templates here yet."}</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              onQueryChange("");
              setChip(null);
            }}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div
          ref={gridRef}
          className="new-project-grid"
          role="radiogroup"
          aria-label="How to start"
          onKeyDown={onGridKeyDown}
        >
          {withClaude && (
            <ClaudeStartCard
              selected={value === CLAUDE_START_ID}
              tabStop={tabStopId === CLAUDE_START_ID}
              onSelect={() => onChange(CLAUDE_START_ID)}
            />
          )}
          {templates.map((entry) => (
            <TemplateCard
              key={entry.id}
              entry={entry}
              compact
              selected={value === entry.id}
              tabStop={entry.id === tabStopId}
              onSelect={() => onChange(entry.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Step two: four across, the user's own themes first, narrowed by All / Yours / Light / Dark and a search. */
function LookStep({
  choices,
  value,
  onChange,
  query,
  onQueryChange,
}: {
  choices: readonly ThemeChoice[];
  value: string;
  onChange: (id: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const [filter, setFilter] = useState<LookFilter>("all");
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);
  const hasOwn = choices.some(({ source }) => source === "workspace");
  const visible = useMemo(
    () => lookChoices(filterThemeChoices(choices, "all", query), filter),
    [choices, filter, query],
  );
  return (
    <div className="new-project-step new-project-look">
      <div className="new-project-filter">
        <FilterChips
          label="Theme filters"
          chips={LOOK_FILTERS.filter(({ id }) => id !== "yours" || hasOwn)}
          value={filter}
          onChange={setFilter}
        />
        <SearchField
          inputRef={searchRef}
          label="Search themes"
          value={query}
          onChange={onQueryChange}
        />
      </div>
      {visible.length === 0 ? (
        <p className="theme-browser-empty new-project-empty">
          {query ? `No themes match “${query}”.` : "No themes here yet."}
        </p>
      ) : (
        <ThemeGrid choices={visible} value={value} onChange={onChange} markOwn />
      )}
    </div>
  );
}

/** Step three: the dated name, preselected so typing replaces it, and the group tucked behind a disclosure. */
function NameStep({
  name,
  onNameChange,
  slug,
  collides,
  groups,
  group,
  onGroupChange,
  groupOpen,
  onGroupOpen,
  onSubmit,
}: {
  name: string;
  onNameChange: (name: string) => void;
  slug: string;
  collides: boolean;
  groups: string[];
  group: string;
  onGroupChange: (group: string) => void;
  groupOpen: boolean;
  onGroupOpen: () => void;
  onSubmit: () => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const groupRef = useRef<HTMLInputElement>(null);
  const openedRef = useRef(groupOpen);
  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);
  useEffect(() => {
    if (groupOpen && !openedRef.current) groupRef.current?.focus();
    openedRef.current = groupOpen;
  }, [groupOpen]);
  return (
    <div className="new-project-step new-project-name">
      <input
        ref={nameRef}
        className="modal-input new-project-name-input"
        type="text"
        aria-label="Project name"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
        }}
      />
      {collides && (
        <p className="modal-warn">{nameCollisionWarning("project", slug)} Pick another name.</p>
      )}
      {groupOpen ? (
        <div className="new-project-group">
          <div className="new-project-group-head">
            <LibraryRailIcon id="group" />
            <span className="new-project-group-label">Group</span>
            <span className="new-project-optional">Optional · sorts projects on Home</span>
          </div>
          {groups.length > 0 && (
            <fieldset className="group-chips" aria-label="Existing groups">
              {groups.map((g) => (
                <button
                  key={g}
                  type="button"
                  className={`group-chip${group.trim() === g ? " selected" : ""}`}
                  aria-pressed={group.trim() === g}
                  onClick={() => onGroupChange(group.trim() === g ? "" : g)}
                >
                  <LibraryRailIcon id="group" />
                  {g}
                </button>
              ))}
            </fieldset>
          )}
          <input
            ref={groupRef}
            className="modal-input new-project-group-input"
            type="text"
            aria-label="Group name"
            placeholder={groups.length > 0 ? "Or type a new group" : "Group name"}
            value={group}
            onChange={(e) => onGroupChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmit();
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          className="new-project-group-toggle"
          aria-expanded={false}
          onClick={onGroupOpen}
        >
          <LibraryRailIcon id="group" />
          <span>Add to a group</span>
          <span className="new-project-optional">Optional</span>
          {railIcon(<path d="m7 10 5 5 5-5" />)}
        </button>
      )}
    </div>
  );
}

function WizardSteps({ step }: { step: Step }) {
  const current = STEPS.findIndex(({ id }) => id === step);
  return (
    <ol className="wizard-steps" aria-label="Progress">
      {STEPS.map(({ id, label }, index) => (
        <li
          key={id}
          className={index < current ? "done" : index === current ? "now" : undefined}
          aria-current={index === current ? "step" : undefined}
        >
          {index > 0 && <span className="wizard-steps-sep" aria-hidden="true" />}
          <span className="wizard-steps-dot" aria-hidden="true">
            {index < current ? CHECK_ICON : index + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  );
}

/** Create-project wizard: how to start (Create with Claude or a template), the look (theme), then the name. The theme applies to the new project's `project.json` after the template copy (`set_project_theme`). */
export function NewProjectDialog({
  initialGroup,
  initialTemplateId,
  onCreate,
  onCancel,
}: {
  /** Preselected welcome-screen group (from a group heading's "+"). */
  initialGroup?: string | null;
  /** Preselected template (the library's "New project from this…"). */
  initialTemplateId?: string | null;
  onCreate: (
    name: string,
    templateId: string,
    themeId: string,
    group: string | null,
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>("start");
  const [startId, setStartId] = useState(
    !initialTemplateId || initialTemplateId === BLANK_TEMPLATE_ID
      ? CLAUDE_START_ID
      : initialTemplateId,
  );
  const [themeId, setThemeId] = useState(DEFAULT_THEME_ID);
  const themeTouched = useRef(false);
  const [themes, setThemes] = useState<ThemeChoice[]>(builtinThemeChoices);
  const [name, setName] = useState(() => defaultProjectName(new Date(), []));
  const nameTouched = useRef(false);
  const [group, setGroup] = useState(initialGroup ?? "");
  const [groupOpen, setGroupOpen] = useState(Boolean(initialGroup));
  const [groups, setGroups] = useState<string[]>([]);
  const [takenSlugs, setTakenSlugs] = useState<string[]>([]);
  const [templateQuery, setTemplateQuery] = useState("");
  const [themeQuery, setThemeQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = slugifyName(name);
  const collides = nameCollision(name, takenSlugs).collides;
  const stepIndex = STEPS.findIndex(({ id }) => id === step);

  // Escape clears an active search first, then closes.
  useEscapeClose(() => {
    if (step === "start" && templateQuery) {
      setTemplateQuery("");
      return;
    }
    if (step === "look" && themeQuery) {
      setThemeQuery("");
      return;
    }
    onCancel();
  }, !busy);

  // Bundled choices resolve synchronously inside; workspace themes join when listed, and the name renumbers once today's projects are known.
  useEffect(() => {
    let cancelled = false;
    void listThemeChoices().then((choices) => {
      if (cancelled) return;
      setThemes(choices);
      if (!themeTouched.current) setThemeId(initialLookThemeId(choices));
    });
    void listProjects()
      .then((list) => {
        if (cancelled) return;
        const names = Array.from(
          new Set(list.map((p) => p.group).filter((g): g is string => Boolean(g))),
        ).sort((a, b) => a.localeCompare(b));
        const slugs = list.map((p) => p.slug);
        setGroups(names);
        setTakenSlugs(slugs);
        if (!nameTouched.current) setName(defaultProjectName(new Date(), slugs));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async () => {
    if (!slug) {
      setError("Give the project a name.");
      return;
    }
    if (collides || busy) return;
    setBusy(true);
    setError(null);
    const templateId = startId === CLAUDE_START_ID ? BLANK_TEMPLATE_ID : startId;
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
      <div className={`modal new-project ${step === "name" ? "narrow" : "wide"}`}>
        <div className="new-project-title">
          <h2>{STEPS[stepIndex].title}</h2>
          <button
            type="button"
            className="modal-close"
            aria-label="Close"
            onClick={onCancel}
            disabled={busy}
          >
            ×
          </button>
        </div>
        {step === "start" && (
          <StartGallery
            value={startId}
            onChange={setStartId}
            query={templateQuery}
            onQueryChange={setTemplateQuery}
          />
        )}
        {step === "look" && (
          <LookStep
            choices={themes}
            value={themeId}
            onChange={(id) => {
              themeTouched.current = true;
              setThemeId(id);
            }}
            query={themeQuery}
            onQueryChange={setThemeQuery}
          />
        )}
        {step === "name" && (
          <NameStep
            name={name}
            onNameChange={(next) => {
              nameTouched.current = true;
              setName(next);
            }}
            slug={slug}
            collides={collides}
            groups={groups}
            group={group}
            onGroupChange={setGroup}
            groupOpen={groupOpen}
            onGroupOpen={() => setGroupOpen(true)}
            onSubmit={() => void submit()}
          />
        )}
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions new-project-actions">
          <WizardSteps step={step} />
          {step === "start" ? (
            <button type="button" className="btn" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() => setStep(STEPS[stepIndex - 1].id)}
              disabled={busy}
            >
              Back
            </button>
          )}
          {step === "name" ? (
            <button
              type="button"
              className="btn primary"
              onClick={() => void submit()}
              disabled={busy || collides}
            >
              {busy ? "Creating…" : "Create project"}
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              onClick={() => setStep(STEPS[stepIndex + 1].id)}
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
