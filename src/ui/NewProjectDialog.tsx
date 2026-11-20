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
  formatTemplateDuration,
  listAllTemplates,
  refreshUserTemplates,
  searchTemplates,
  subscribeTemplates,
  TEMPLATE_CATEGORIES,
  type TemplateEntry,
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
  availableLooks,
  CLAUDE_START_ID,
  defaultProjectName,
  gridColumnCount,
  initialLookThemeId,
  type LookFilter,
  lookChoices,
  lookSelection,
  MINE_CHIP,
  type ShownLook,
  type StartChip,
  selectionAfterFilter,
  startAfterSearch,
  startCards,
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
import { useSlashFocus } from "./useSlashFocus";

type Step = "start" | "look" | "name";

const STEPS: { id: Step; label: string; title: string }[] = [
  { id: "start", label: "Start", title: "How do you want to start?" },
  { id: "look", label: "Look", title: "Pick a look" },
  { id: "name", label: "Name", title: "Name" },
];

const SEARCH_ICON = railIcon(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </>,
);

const SONG_ICON = railIcon(
  <>
    <path d="M9 17.5V6l10-2v11.5" />
    <circle cx="6.5" cy="17.5" r="2.5" />
    <circle cx="16.5" cy="15.5" r="2.5" />
  </>,
);

const BRING_ICON = railIcon(
  <>
    <path d="M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20" />
    <path d="M5.5 7.5L4 13.5V18a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 18v-4.5l-1.5-6" />
    <path d="M12 3.5v7m0 0l-2.5-2.5M12 10.5l2.5-2.5" />
  </>,
);

const HIGHLIGHT_ICON = railIcon(
  <path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7L12 4z" />,
);

const NO_LOOKS: readonly string[] = [];

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

/** Enter that commits an IME composition (keyCode 229 in WebKit) must not submit. */
function isSubmitEnter(e: React.KeyboardEvent): boolean {
  return e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229;
}

/** The footer buttons change meaning under the pointer, so the second click of a double-click is dropped rather than landing on the next step's action. */
function singleClick(action: () => void) {
  return (e: React.MouseEvent) => {
    if (e.detail > 1) return;
    action();
  };
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
  entries,
  value,
  onChange,
  chip,
  onChipChange,
  query,
  onQueryChange,
  claudeStart,
}: {
  entries: readonly TemplateEntry[];
  value: string;
  onChange: (id: string) => void;
  /** Chip and search are owned by the dialog, so Back returns to the same view and Escape can clear the search first. */
  chip: StartChip;
  onChipChange: (chip: StartChip) => void;
  query: string;
  onQueryChange: (query: string) => void;
  claudeStart: boolean;
}) {
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
  const { templates, withClaude, ids } = useMemo(
    () => startCards(entries, chip, query, claudeStart),
    [entries, chip, query, claudeStart],
  );
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

  const pickChip = (next: StartChip) => {
    onChipChange(next);
    onChange(selectionAfterFilter(value, startCards(entries, next, query, claudeStart).ids));
  };

  const onQuery = (next: string) => {
    const after = startAfterSearch(entries, chip, next, value, claudeStart);
    if (after.chip !== chip) onChipChange(after.chip);
    onQueryChange(next);
    if (after.selected !== value) onChange(after.selected);
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
    const columns = gridRef.current
      ? gridColumnCount(getComputedStyle(gridRef.current).gridTemplateColumns, 3)
      : 3;
    const next = startGridStep(
      e.key,
      ids.indexOf(value),
      ids.length,
      withClaude,
      columns,
      e.metaKey,
    );
    if (next === null) return;
    e.preventDefault();
    moveTo(next);
  };

  return (
    <div className="new-project-step new-project-start">
      {libraryError && (
        <p className="modal-error" role="alert">
          {libraryError}
        </p>
      )}
      <div className="new-project-filter">
        <FilterChips label="Template categories" chips={chips} value={chip} onChange={pickChip} />
        <SearchField
          inputRef={searchRef}
          label="Search templates"
          value={query}
          onChange={onQuery}
        />
      </div>
      <span className="visually-hidden" aria-live="polite">
        {`${ids.length} ${ids.length === 1 ? "way to start" : "ways to start"}`}
      </span>
      {ids.length === 0 ? (
        <div className="template-empty new-project-empty">
          <p>{query ? `No templates match “${query}”.` : "No templates here yet."}</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              onQueryChange("");
              onChipChange(null);
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

function DetailList({
  icon,
  label,
  items,
}: {
  icon: ReactElement;
  label: string;
  items: readonly string[];
}) {
  return (
    <div className="new-project-details-row" title={items.join(" · ")}>
      {icon}
      <span className="new-project-details-label">{label}</span>
      <ul className="new-project-details-items">
        {[...new Set(items)].map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** What the selection will make, under the grid at a fixed height so the wizard never resizes: the song, what to bring and the highlights. */
function StartDetails({ entry, claude }: { entry: TemplateEntry | undefined; claude: boolean }) {
  if (claude) {
    return (
      <section className="new-project-details" aria-label="Create with Claude">
        <div className="new-project-details-head">
          <span className="new-project-details-name">
            <ClaudeSpark />
            Create with Claude
          </span>
          <span className="new-project-details-tagline">
            Describe the video and Claude builds it, on the look you pick next.
          </span>
        </div>
      </section>
    );
  }
  if (!entry) return <section className="new-project-details" aria-hidden="true" />;
  return (
    <section className="new-project-details" aria-label={`${entry.name} details`}>
      <div className="new-project-details-head">
        <span className="new-project-details-name">{entry.name}</span>
        {entry.tagline && (
          <span className="new-project-details-tagline" title={entry.tagline}>
            {entry.tagline}
          </span>
        )}
        <span className="new-project-details-meta">
          {`${entry.sceneCount} ${entry.sceneCount === 1 ? "scene" : "scenes"} · ${formatTemplateDuration(entry.durationMs)}`}
        </span>
        {entry.song && (
          <span className="template-chip song">
            {SONG_ICON}
            {`${entry.song.title} · ${entry.song.bpm} BPM`}
          </span>
        )}
      </div>
      {entry.bring.length > 0 && (
        <DetailList icon={BRING_ICON} label="You'll need" items={entry.bring} />
      )}
      {entry.highlights.length > 0 && (
        <DetailList icon={HIGHLIGHT_ICON} label="Highlights" items={entry.highlights} />
      )}
    </section>
  );
}

/** Step two: four across, the template's looks first (the first preselected), then the user's own themes, narrowed by All / Yours / Light / Dark and a search. */
function LookStep({
  choices,
  looks,
  value,
  onPick,
  onAutoSelect,
  filter,
  onFilterChange,
  query,
  onQueryChange,
}: {
  choices: readonly ThemeChoice[];
  looks: readonly string[];
  value: string;
  /** The user chose a look. */
  onPick: (id: string) => void;
  /** A filter chip moved the selection off a hidden card, which is not a pick. */
  onAutoSelect: (id: string) => void;
  filter: LookFilter;
  onFilterChange: (filter: LookFilter) => void;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);
  const hasOwn = choices.some(({ source }) => source === "workspace");
  const listed = (next: LookFilter, search = query) =>
    lookChoices(filterThemeChoices(choices, "all", search), next, looks);
  const visible = useMemo(
    () => lookChoices(filterThemeChoices(choices, "all", query), filter, looks),
    [choices, filter, query, looks],
  );
  const suggested = useMemo(() => availableLooks(choices, looks), [choices, looks]);
  const follow = (shown: readonly ThemeChoice[]) => {
    const id = selectionAfterFilter(
      value,
      shown.map((choice) => choice.id),
    );
    if (id !== value) onAutoSelect(id);
  };
  const pickFilter = (next: LookFilter) => {
    onFilterChange(next);
    follow(listed(next));
  };
  const onQuery = (next: string) => {
    onQueryChange(next);
    follow(listed(filter, next));
  };
  return (
    <div className="new-project-step new-project-look">
      <div className="new-project-filter">
        <FilterChips
          label="Theme filters"
          chips={LOOK_FILTERS.filter(({ id }) => id !== "yours" || hasOwn)}
          value={filter}
          onChange={pickFilter}
        />
        <SearchField inputRef={searchRef} label="Search themes" value={query} onChange={onQuery} />
      </div>
      <span className="visually-hidden" aria-live="polite">
        {`${visible.length} ${visible.length === 1 ? "theme" : "themes"}`}
      </span>
      {visible.length === 0 ? (
        <p className="theme-browser-empty new-project-empty">
          {query ? `No themes match “${query}”.` : "No themes here yet."}
        </p>
      ) : (
        <ThemeGrid
          choices={visible}
          value={value}
          onChange={onPick}
          markOwn
          suggestedIds={suggested}
        />
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
          if (isSubmitEnter(e)) onSubmit();
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
              if (isSubmitEnter(e)) onSubmit();
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
  claudeStart = true,
  initialGroup,
  initialTemplateId,
  onCreate,
  onCancel,
}: {
  /** False where a configuration profile turns Claude off: no Create with Claude card, Blank listed instead. */
  claudeStart?: boolean;
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
  const entries = useSyncExternalStore(subscribeTemplates, listAllTemplates);
  const [startId, setStartId] = useState(
    !initialTemplateId || initialTemplateId === BLANK_TEMPLATE_ID
      ? claudeStart
        ? CLAUDE_START_ID
        : BLANK_TEMPLATE_ID
      : initialTemplateId,
  );
  const [templateChip, setTemplateChip] = useState<StartChip>(null);
  const [templateQuery, setTemplateQuery] = useState("");
  const templateId = startId === CLAUDE_START_ID ? BLANK_TEMPLATE_ID : startId;
  const template = useMemo(
    () => entries.find((entry) => entry.id === templateId),
    [entries, templateId],
  );
  const [themes, setThemes] = useState<ThemeChoice[]>(builtinThemeChoices);
  const looks = template?.looks ?? NO_LOOKS;
  const looksKey = JSON.stringify(looks);
  // The look follows the template until the user picks one; once shown, a late listing never swaps it.
  const [pickedThemeId, setPickedThemeId] = useState<string | null>(null);
  const [shownLook, setShownLook] = useState<ShownLook | null>(null);
  const themeId = lookSelection(
    pickedThemeId,
    shownLook,
    looksKey,
    initialLookThemeId(themes, looks),
  );
  const [lookFilter, setLookFilter] = useState<LookFilter>("all");
  const [themeQuery, setThemeQuery] = useState("");
  const [name, setName] = useState(() => defaultProjectName(new Date(), []));
  const nameTouched = useRef(false);
  const [group, setGroup] = useState(initialGroup ?? "");
  const [groupOpen, setGroupOpen] = useState(Boolean(initialGroup));
  const [groups, setGroups] = useState<string[]>([]);
  const [takenSlugs, setTakenSlugs] = useState<string[]>([]);
  const [slugsLoaded, setSlugsLoaded] = useState(false);
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
      if (!cancelled) setThemes(choices);
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
        setSlugsLoaded(true);
        if (!nameTouched.current) setName(defaultProjectName(new Date(), slugs));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const goTo = (index: number) => {
    setError(null);
    const next = STEPS[index].id;
    if (next === "look" && shownLook?.looksKey !== looksKey) {
      setShownLook({ looksKey, id: themeId });
      // A fresh seed is always on screen: a filter or search left from another template gives way.
      const listed = lookChoices(filterThemeChoices(themes, "all", themeQuery), lookFilter, looks);
      const hidden = !listed.some((choice) => choice.id === themeId);
      if (hidden && themes.some((choice) => choice.id === themeId)) {
        setLookFilter("all");
        setThemeQuery("");
      }
    }
    setStep(next);
  };

  const submit = async () => {
    if (busy) return;
    if (!slug) {
      setError("Give the project a name.");
      return;
    }
    if (collides) return;
    setBusy(true);
    setError(null);
    let finalName = name;
    if (!slugsLoaded) {
      // The listing failed or is still out: read it now, so the dated default renumbers instead of failing with "already exists".
      const slugs = await listProjects()
        .then((list) => list.map((p) => p.slug))
        .catch(() => null);
      if (slugs) {
        setTakenSlugs(slugs);
        setSlugsLoaded(true);
        if (!nameTouched.current) finalName = defaultProjectName(new Date(), slugs);
        else if (nameCollision(finalName, slugs).collides) {
          setBusy(false);
          return;
        }
        setName(finalName);
      }
    }
    try {
      await recordSuccessfulThemeUse(themeId, () =>
        onCreate(finalName, templateId, themeId, group.trim() || null),
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
          <>
            <StartGallery
              entries={entries}
              value={startId}
              onChange={setStartId}
              chip={templateChip}
              onChipChange={setTemplateChip}
              query={templateQuery}
              onQueryChange={setTemplateQuery}
              claudeStart={claudeStart}
            />
            <StartDetails entry={template} claude={startId === CLAUDE_START_ID} />
          </>
        )}
        {step === "look" && (
          <LookStep
            choices={themes}
            looks={looks}
            value={themeId}
            onPick={setPickedThemeId}
            onAutoSelect={(id) =>
              pickedThemeId === null ? setShownLook({ looksKey, id }) : setPickedThemeId(id)
            }
            filter={lookFilter}
            onFilterChange={setLookFilter}
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
              onClick={singleClick(() => goTo(stepIndex - 1))}
              disabled={busy}
            >
              Back
            </button>
          )}
          {step === "name" ? (
            <button
              type="button"
              className="btn primary"
              onClick={singleClick(() => void submit())}
              disabled={busy || collides}
            >
              {busy ? "Creating…" : "Create project"}
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              onClick={singleClick(() => goTo(stepIndex + 1))}
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
