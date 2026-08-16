const TEXT_ICON_RECENTS_KEY = "kookaburra:text-icon-recents";
const MAX_VISIBLE_RECENTS = 10;
const MAX_STORED_RECENTS = 100;

interface TextIconRecentEntry {
  value: string;
  projectId?: string;
}

interface TextIconRecentStore {
  version: 1;
  entries: TextIconRecentEntry[];
}

let sessionStore: TextIconRecentStore = { version: 1, entries: [] };
let sessionStoreDirty = false;

function isProjectImage(value: string): boolean {
  return value.startsWith("assets/");
}

export function parseTextIconRecentStore(raw: string | null): TextIconRecentStore {
  if (!raw) return { version: 1, entries: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return {
        version: 1,
        entries: parsed
          .filter((value): value is string => typeof value === "string")
          .filter((value) => value.length > 0 && !isProjectImage(value))
          .map((value) => ({ value })),
      };
    }
    if (!parsed || typeof parsed !== "object") return { version: 1, entries: [] };
    const candidate = parsed as { version?: unknown; entries?: unknown };
    if (candidate.version !== 1 || !Array.isArray(candidate.entries)) {
      return { version: 1, entries: [] };
    }
    const entries: TextIconRecentEntry[] = [];
    for (const entry of candidate.entries) {
      if (!entry || typeof entry !== "object") continue;
      const value = (entry as { value?: unknown }).value;
      const projectId = (entry as { projectId?: unknown }).projectId;
      if (typeof value !== "string" || value.length === 0) continue;
      if (isProjectImage(value)) {
        if (typeof projectId === "string" && projectId.length > 0) {
          entries.push({ value, projectId });
        }
      } else {
        entries.push({ value });
      }
    }
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: [] };
  }
}

export function visibleTextIconRecents(store: TextIconRecentStore, projectId: string): string[] {
  const seen = new Set<string>();
  const visible: string[] = [];
  for (const entry of store.entries) {
    if (entry.projectId !== undefined && entry.projectId !== projectId) continue;
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    visible.push(entry.value);
    if (visible.length === MAX_VISIBLE_RECENTS) break;
  }
  return visible;
}

export function addTextIconRecent(
  store: TextIconRecentStore,
  projectId: string,
  value: string,
): TextIconRecentStore {
  if (!value) return store;
  const scope = isProjectImage(value) ? projectId : undefined;
  const entries = store.entries.filter(
    (entry) => entry.value !== value || entry.projectId !== scope,
  );
  return {
    version: 1,
    entries: [{ value, ...(scope ? { projectId: scope } : {}) }, ...entries].slice(
      0,
      MAX_STORED_RECENTS,
    ),
  };
}

function readTextIconRecentStore(): TextIconRecentStore {
  if (sessionStoreDirty) return sessionStore;
  try {
    if (typeof localStorage === "undefined") return sessionStore;
    sessionStore = parseTextIconRecentStore(localStorage.getItem(TEXT_ICON_RECENTS_KEY));
  } catch {
    return sessionStore;
  }
  return sessionStore;
}

export function resetTextIconRecentSessionStore(): void {
  sessionStore = { version: 1, entries: [] };
  sessionStoreDirty = false;
}

export function loadTextIconRecents(projectId: string): string[] {
  return visibleTextIconRecents(readTextIconRecentStore(), projectId);
}

export function storeTextIconRecent(projectId: string, value: string): string[] {
  const next = addTextIconRecent(readTextIconRecentStore(), projectId, value);
  sessionStore = next;
  try {
    if (typeof localStorage === "undefined") {
      sessionStoreDirty = true;
      return visibleTextIconRecents(next, projectId);
    }
    localStorage.setItem(TEXT_ICON_RECENTS_KEY, JSON.stringify(next));
    sessionStoreDirty = false;
  } catch {
    sessionStoreDirty = true;
    return visibleTextIconRecents(next, projectId);
  }
  return visibleTextIconRecents(next, projectId);
}
