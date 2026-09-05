import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  bundledThemePreviews: vi.fn(),
  cachedThemePreviews: vi.fn(),
  themePreviewKey: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../engine/themePreviews", () => ({
  bundledThemePreviews: mocks.bundledThemePreviews,
  cachedThemePreviews: mocks.cachedThemePreviews,
  themePreviewKey: mocks.themePreviewKey,
  THEME_PREVIEW_COUNT: 4,
}));

import { BUILTIN_THEME_CATALOGUE, filterThemeCatalogue } from "../theme/catalogue";
import {
  applyDragOrder,
  builtinThemeChoices,
  collectionAfterThemeSelection,
  countThemeChoicesByCollection,
  filterThemeChoices,
  listThemeChoices,
  RECENT_THEME_LIMIT,
  RECENT_THEMES_STORAGE_KEY,
  readRecentThemeIds,
  recordRecentThemeUse,
  recordSuccessfulThemeUse,
  reorderableScope,
  type ThemeChoice,
  ThemeGrid,
} from "./ThemePicker";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.invoke.mockReset();
  mocks.bundledThemePreviews.mockReset();
  mocks.cachedThemePreviews.mockReset();
  mocks.themePreviewKey.mockReset();
  mocks.bundledThemePreviews.mockImplementation((id: string) => [`${id}-1.jpg`]);
});

function choice(overrides: Partial<ThemeChoice> & Pick<ThemeChoice, "id" | "name">): ThemeChoice {
  return {
    source: "bundled",
    useLabel: "Product story",
    tags: [],
    previews: null,
    background: "#000000",
    accent: "#ff0000",
    text: "#ffffff",
    ...overrides,
  };
}

function workspaceDoc(name: string, catalogue?: Record<string, unknown>) {
  return {
    version: 2,
    id: "document-id",
    name,
    mode: "dark",
    ...(catalogue ? { catalogue } : {}),
    colors: { background: "#000000", text: "#ffffff", accent: "#ff0000", muted: "#888888" },
    typography: {
      headline: { family: "Avenir Next", weight: 600 },
      body: { family: "Inter", weight: 400 },
      scale: 1.25,
    },
    motion: {
      durations: { fast: 200, base: 500, slow: 900 },
      easings: { standard: "outQuad", emphasized: "outExpo" },
    },
  };
}

describe("theme choice collections", () => {
  const choices = [
    choice({
      id: "kookaburra-clean",
      name: "Clean",
      category: "essentials",
      tags: ["minimal"],
      fontTraits: ["Inter"],
    }),
    choice({
      id: "kookaburra-calm",
      name: "Calm",
      category: "quiet-technology",
      tags: ["soft"],
      fontTraits: ["Space Grotesk"],
    }),
    choice({
      id: "ws:personal",
      name: "Personal",
      source: "workspace",
      category: "quiet-technology",
      useLabel: "Private AI notes",
      tags: ["calm", "assistant"],
      fontTraits: ["Avenir Next"],
    }),
  ];

  it("supports All, Recent, category and My themes collections", () => {
    expect(filterThemeChoices(choices).map(({ id }) => id)).toEqual([
      "kookaburra-clean",
      "kookaburra-calm",
      "ws:personal",
    ]);
    expect(
      filterThemeChoices(choices, "recent", "", ["ws:personal", "missing", "kookaburra-clean"]).map(
        ({ id }) => id,
      ),
    ).toEqual(["ws:personal", "kookaburra-clean"]);
    expect(filterThemeChoices(choices, "quiet-technology").map(({ id }) => id)).toEqual([
      "kookaburra-calm",
    ]);
    expect(filterThemeChoices(choices, "my-themes").map(({ id }) => id)).toEqual(["ws:personal"]);
  });

  it("makes search global across metadata and font traits", () => {
    expect(filterThemeChoices(choices, "essentials", "private avenir").map(({ id }) => id)).toEqual(
      ["ws:personal"],
    );
    expect(
      filterThemeChoices(choices, "my-themes", "quiet technology").map(({ id }) => id),
    ).toEqual(["kookaburra-calm", "ws:personal"]);
  });

  it("counts every collection while keeping workspace themes out of use-case counts", () => {
    expect(countThemeChoicesByCollection(choices, ["ws:personal", "missing"])).toMatchObject({
      all: 3,
      recent: 1,
      essentials: 1,
      "quiet-technology": 1,
      "my-themes": 1,
    });
  });

  it("keeps a selected global search result visible after the search clears", () => {
    expect(collectionAfterThemeSelection("essentials", "avenir")).toBe("all");
    expect(collectionAfterThemeSelection("my-themes", "  ")).toBe("my-themes");
  });
});

describe("ThemeGrid markup", () => {
  it("renders a roving focus-then-activate listbox and defers secondary preview frames", () => {
    const choices = [
      choice({
        id: "first",
        name: "First",
        useLabel: "First use",
        previews: ["first-1.jpg", "first-2.jpg", "first-3.jpg", "first-4.jpg"],
      }),
      choice({ id: "second", name: "Second", useLabel: "Second use" }),
    ];
    const html = renderToStaticMarkup(
      createElement(ThemeGrid, {
        choices,
        value: "second",
        onChange: () => {},
      }),
    );
    expect(html).toContain('role="listbox"');
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html).toContain('tabindex="0" aria-selected="true"');
    expect(html).toContain('loading="lazy" decoding="async"');
    expect(html).toContain("First use");
    expect(html).not.toContain("first-2.jpg");
  });
});

describe("recent themes", () => {
  function memoryStorage(initial?: string) {
    const values = new Map<string, string>();
    if (initial !== undefined) values.set(RECENT_THEMES_STORAGE_KEY, initial);
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
  }

  it("deduplicates, promotes and caps explicit theme use", () => {
    const storage = memoryStorage();
    for (let index = 0; index < RECENT_THEME_LIMIT + 3; index++) {
      recordRecentThemeUse(`theme-${index}`, storage);
    }
    expect(readRecentThemeIds(storage)).toEqual([
      "theme-10",
      "theme-9",
      "theme-8",
      "theme-7",
      "theme-6",
      "theme-5",
      "theme-4",
      "theme-3",
    ]);
    recordRecentThemeUse("theme-7", storage);
    expect(readRecentThemeIds(storage)[0]).toBe("theme-7");
    expect(new Set(readRecentThemeIds(storage)).size).toBe(RECENT_THEME_LIMIT);
  });

  it("degrades malformed storage to an empty list", () => {
    expect(readRecentThemeIds(memoryStorage("not json"))).toEqual([]);
    expect(readRecentThemeIds(memoryStorage(JSON.stringify({ id: "wrong" })))).toEqual([]);
  });

  it("records only successful theme use", async () => {
    const storage = memoryStorage();
    await expect(recordSuccessfulThemeUse("theme-ok", async () => "done", storage)).resolves.toBe(
      "done",
    );
    await expect(
      recordSuccessfulThemeUse(
        "theme-failed",
        async () => {
          throw new Error("failed");
        },
        storage,
      ),
    ).rejects.toThrow("failed");
    expect(readRecentThemeIds(storage)).toEqual(["theme-ok"]);
  });
});

describe("listThemeChoices", () => {
  it("builds bundled choices synchronously without workspace IPC", () => {
    const choices = builtinThemeChoices();
    expect(choices).toHaveLength(filterThemeCatalogue(BUILTIN_THEME_CATALOGUE).length);
    expect(choices.every(({ source }) => source === "bundled")).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("keeps malformed workspace documents isolated and resolves previews concurrently", async () => {
    const rich = JSON.stringify(
      workspaceDoc("Personal Nebula", {
        category: "human-centred-ai",
        useLabel: "Thoughtful assistant stories",
        tags: ["calm", "assistant"],
        stage: "lighting-only",
      }),
    );
    const plain = JSON.stringify(workspaceDoc("Plain Workspace"));
    mocks.invoke.mockResolvedValue([
      { slug: "broken", json: "{" },
      { slug: "personal", json: rich },
      { slug: "plain", json: plain },
    ]);

    const resolvers: (() => void)[] = [];
    mocks.themePreviewKey.mockImplementation(
      (json: string) =>
        new Promise<string>((resolve) => {
          resolvers.push(() => resolve(json === rich ? "rich-key" : "plain-key"));
        }),
    );
    mocks.cachedThemePreviews.mockImplementation(async (key: string) => [`${key}-1.jpg`]);

    const pending = listThemeChoices();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolvers).toHaveLength(2);
    for (const resolve of resolvers) resolve();
    const choices = await pending;

    expect(choices.filter(({ source }) => source === "bundled")).toHaveLength(
      filterThemeCatalogue(BUILTIN_THEME_CATALOGUE).length,
    );
    expect(choices.find(({ id }) => id === "ws:broken")).toBeUndefined();
    expect(choices.find(({ id }) => id === "ws:personal")).toMatchObject({
      source: "workspace",
      name: "Personal Nebula",
      useLabel: "Thoughtful assistant stories",
      tags: ["calm", "assistant"],
      category: "human-centred-ai",
      stage: "lighting-only",
      fontTraits: ["Avenir Next", "Inter"],
      previews: ["rich-key-1.jpg"],
    });
    expect(choices.find(({ id }) => id === "ws:plain")).toMatchObject({
      source: "workspace",
      useLabel: "Custom workspace theme",
      tags: [],
      stage: "none",
      previews: ["plain-key-1.jpg"],
    });
  });
});

describe("workspace ordering and drag reorder", () => {
  it("sorts My themes on catalogue.order, alphabetically where there is none", async () => {
    const ordered = (name: string, order?: number) =>
      JSON.stringify(
        workspaceDoc(name, {
          category: "essentials",
          useLabel: `${name} label`,
          tags: [],
          stage: "none",
          ...(order === undefined ? {} : { order }),
        }),
      );
    // A hand-written theme the strict catalogue parser rejects still keeps the order the reorder command wrote into it.
    const partial = JSON.stringify(workspaceDoc("Partial", { order: 15 }));
    mocks.invoke.mockResolvedValue([
      { slug: "zebra", json: ordered("Zebra", 10) },
      { slug: "unordered-b", json: ordered("Beta") },
      { slug: "apple", json: ordered("Apple", 20) },
      { slug: "unordered-a", json: ordered("Alpha") },
      { slug: "partial", json: partial },
    ]);
    mocks.themePreviewKey.mockResolvedValue("key");
    mocks.cachedThemePreviews.mockResolvedValue(null);

    const choices = await listThemeChoices();
    expect(choices.filter(({ source }) => source === "workspace").map(({ id }) => id)).toEqual([
      "ws:zebra",
      "ws:partial",
      "ws:apple",
      "ws:unordered-a",
      "ws:unordered-b",
    ]);
  });

  it("only offers a reorder where the listing has one writable order", () => {
    expect(reorderableScope("my-themes", false)).toBe("workspace");
    expect(reorderableScope("my-themes", true)).toBeNull();
    expect(reorderableScope("all", false)).toBeNull();
    expect(reorderableScope("recent", false)).toBeNull();
    // Vitest runs as a dev build, so the checkout-only bundled case is the live one here.
    expect(reorderableScope("essentials", false)).toBe("bundled");
  });

  it("re-sorts a page by a drag's ids and leaves unknown cards at the end", () => {
    const page = [
      choice({ id: "a", name: "A" }),
      choice({ id: "b", name: "B" }),
      choice({ id: "c", name: "C" }),
    ];
    expect(applyDragOrder(page, ["c", "a"]).map(({ id }) => id)).toEqual(["c", "a", "b"]);
    expect(applyDragOrder(page, []).map(({ id }) => id)).toEqual(["a", "b", "c"]);
  });
});
