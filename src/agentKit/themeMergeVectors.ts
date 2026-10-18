import { collectParseWarnings } from "../engine/parseWarnings";
import { mergeThemeDocs, resolveThemeDocument } from "../theme/extends";

/** Conformance vectors for theme `extends`: every input goes through the app's own `mergeThemeDocs` and `resolveThemeDocument`, and the kit (`kblib/themes.py`) and packs (`src-tauri/src/theme.rs`) replay them, so the three merges cannot drift. `problem` names why a chain broke (`out` is then null) or why `extends` was ignored. */

type Doc = Record<string, unknown>;

export type ThemeChainProblem = "missing" | "cycle" | "too-long" | "version" | "invalid";

export interface ThemeMergeVector {
  id: string;
  base: Doc;
  child: Doc;
  out: Doc;
}

export interface ThemeResolveVector {
  id: string;
  source: string;
  raw: Doc;
  docs: Record<string, Doc>;
  out: Doc | null;
  problem: ThemeChainProblem | null;
}

export interface ThemeMergeVectors {
  version: 1;
  merge: ThemeMergeVector[];
  resolve: ThemeResolveVector[];
}

const base: Doc = {
  version: 2,
  id: "base",
  name: "Base",
  catalogue: { category: "essentials", useLabel: "Base", tags: ["brand"], stage: "none" },
  mode: "dark",
  colors: { background: "#0b1020", text: "#f4f6fb", accent: "#ff5a36", muted: "#8a94ab" },
  typography: { headline: { family: "Space Grotesk", weight: 600 }, body: "Inter", scale: 1.25 },
  motion: {
    durations: { fast: 200, base: 500, slow: 900 },
    easings: { standard: "outCubic", emphasized: "outExpo" },
  },
  chartColors: ["#ff5a36", "#3ad1c4"],
  gradients: {
    brand: {
      type: "linear",
      angleDeg: 160,
      stops: [
        ["#0b1020", 0],
        ["#1b2350", 1],
      ],
    },
  },
  background: { type: "gradient", gradient: "brand", parallax: 0.2 },
  lighting: { sun: { azimuthDeg: 35, elevationDeg: 40, intensity: 1.8 }, ambient: 0.4 },
};

const variant = (fields: Doc, version = 3): Doc => ({
  version,
  id: "variant",
  name: "Variant",
  ...fields,
});

const MERGES: Omit<ThemeMergeVector, "out">[] = [
  { id: "identity-only-child", base, child: variant({}) },
  {
    id: "scalar-replaces",
    base,
    child: variant({ mode: "light", colors: { accent: "#00aa88" } }),
  },
  {
    id: "objects-merge-deep",
    base,
    child: variant({ lighting: { sun: { intensity: 2.4 } }, typography: { scale: 1.4 } }),
  },
  {
    id: "arrays-replace-whole",
    base,
    child: variant({
      chartColors: ["#111111"],
      gradients: {
        brand: {
          stops: [
            ["#000000", 0],
            ["#ffffff", 1],
          ],
        },
      },
    }),
  },
  { id: "null-clears-top-level", base, child: variant({ background: null, chartColors: null }) },
  {
    id: "null-clears-nested",
    base,
    child: variant({ lighting: { ambient: null }, background: { parallax: null } }),
  },
  { id: "null-for-absent-key", base, child: variant({ effects: null, card: { radius: null } }) },
  {
    id: "object-over-scalar",
    base: { ...base, textLook: "plain" },
    child: variant({ textLook: { preset: "outline", strokeEm: null } }),
  },
  { id: "scalar-over-object", base, child: variant({ background: "none" }) },
  {
    id: "identity-never-inherited",
    base: { ...base, extends: "kookaburra-midnight" },
    child: { version: 3, extends: "ws:base", colors: { muted: "#999999" } },
  },
  {
    id: "nested-identity-names-inherit",
    base: { ...base, lighting: { name: "rig", id: "key", version: 4, sun: { intensity: 1 } } },
    child: variant({ lighting: { sun: { intensity: 2 } } }),
  },
  {
    id: "array-of-objects-replaces",
    base: { ...base, lighting: { lights: [{ id: "a", intensity: 1 }, { id: "b" }] } },
    child: variant({ lighting: { lights: [{ id: "a", intensity: 3 }] } }),
  },
  {
    id: "type-switch-keeps-stale-fields",
    base,
    child: variant({ background: { type: "color", color: "#101010" } }),
  },
];

const ws = (slug: string) => `ws:${slug}`;

const RESOLVES: Omit<ThemeResolveVector, "out" | "problem">[] = [
  { id: "no-extends-is-unchanged", source: ws("solo"), raw: base, docs: {} },
  {
    id: "workspace-base",
    source: ws("variant"),
    raw: variant({ extends: ws("base"), colors: { accent: "#00aa88" } }),
    docs: { [ws("base")]: base },
  },
  {
    id: "bundled-base",
    source: ws("variant"),
    raw: variant({ extends: "kookaburra-midnight", mode: "light" }),
    docs: { "kookaburra-midnight": { ...base, id: "kookaburra-midnight", name: "Midnight" } },
  },
  {
    id: "chain-of-three",
    source: ws("grandchild"),
    raw: variant({ extends: ws("child"), lighting: { ambient: 0.9 }, background: null }),
    docs: {
      [ws("child")]: variant({
        extends: ws("base"),
        name: "Child",
        lighting: { sun: { intensity: 3 }, ambient: null },
        chartColors: ["#222222", "#333333"],
      }),
      [ws("base")]: base,
    },
  },
  {
    id: "chain-re-adds-a-cleared-value",
    source: ws("grandchild"),
    raw: variant({ extends: ws("child"), background: { type: "color", color: "#202020" } }),
    docs: {
      [ws("child")]: variant({ extends: ws("base"), background: null }),
      [ws("base")]: base,
    },
  },
  {
    id: "missing-base",
    source: ws("variant"),
    raw: variant({ extends: ws("gone") }),
    docs: {},
  },
  {
    id: "missing-grandparent",
    source: ws("variant"),
    raw: variant({ extends: ws("child") }),
    docs: { [ws("child")]: variant({ extends: ws("gone") }) },
  },
  {
    id: "self-cycle",
    source: ws("loop"),
    raw: variant({ extends: ws("loop") }),
    docs: { [ws("loop")]: variant({ extends: ws("loop") }) },
  },
  {
    id: "two-step-cycle",
    source: ws("a"),
    raw: variant({ extends: ws("b") }),
    docs: { [ws("a")]: variant({ extends: ws("b") }), [ws("b")]: variant({ extends: ws("a") }) },
  },
  {
    id: "too-long",
    source: ws("t0"),
    raw: variant({ extends: ws("t1") }),
    docs: Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [
        ws(`t${i + 1}`),
        variant({ extends: ws(`t${i + 2}`) }),
      ]),
    ),
  },
  {
    id: "v2-extends-ignored",
    source: ws("old"),
    raw: { ...base, extends: ws("other") },
    docs: { [ws("other")]: { ...base, mode: "light" } },
  },
  {
    id: "non-string-extends-ignored",
    source: ws("odd"),
    raw: { ...base, version: 3, extends: 7 },
    docs: {},
  },
  {
    id: "v2-base-extends-not-followed",
    source: ws("variant"),
    raw: variant({ extends: ws("legacy"), mode: "light" }),
    docs: { [ws("legacy")]: { ...base, extends: ws("gone") } },
  },
];

function problemOf(warnings: readonly string[]): ThemeChainProblem | null {
  const text = warnings.join("\n");
  if (text.includes("loops back")) return "cycle";
  if (text.includes("can't be found")) return "missing";
  if (text.includes("more than")) return "too-long";
  if (text.includes("needs theme version")) return "version";
  if (text.includes("must name a theme")) return "invalid";
  return null;
}

const detached = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function buildThemeMergeVectors(): ThemeMergeVectors {
  return {
    version: 1,
    merge: MERGES.map((v) => ({
      ...detached(v),
      out: mergeThemeDocs(detached(v.base), detached(v.child)),
    })),
    resolve: RESOLVES.map((v) => {
      const docs = detached(v.docs);
      const { result, warnings } = collectParseWarnings(() =>
        resolveThemeDocument(detached(v.raw), v.source, (id) => docs[id]),
      );
      return {
        ...detached(v),
        out: result === undefined ? null : (result as Doc),
        problem: problemOf(warnings),
      };
    }),
  };
}

export function serialiseThemeMergeVectors(vectors: ThemeMergeVectors): string {
  return `${JSON.stringify(vectors, null, 2)}\n`;
}
