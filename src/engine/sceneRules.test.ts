import { describe, expect, it } from "vitest";

// The scene-authoring hard rules that byte-identical export rests on (CLAUDE.md, "Scene-authoring hard rules"), enforced over every bundled, preset and fixture scene source: motion comes from the timeline, exported pixels never come from the DOM, and assets live in the project.
const sources = {
  ...import.meta.glob<string>("../../projects/*/scenes/*.tsx", {
    eager: true,
    query: "?raw",
    import: "default",
  }),
  ...import.meta.glob<string>("../../presets/*/scenes/*.tsx", {
    eager: true,
    query: "?raw",
    import: "default",
  }),
  ...import.meta.glob<string>("../../fixtures/**/scenes/*.tsx", {
    eager: true,
    query: "?raw",
    import: "default",
  }),
};

const RULES: { rule: string; pattern: RegExp }[] = [
  { rule: "reads the wall clock (Date.now)", pattern: /\bDate\.now\s*\(/ },
  { rule: "reads the wall clock (performance.now)", pattern: /\bperformance\.now\s*\(/ },
  { rule: "reads the wall clock (new Date)", pattern: /\bnew\s+Date\s*\(/ },
  {
    rule: "schedules its own frames (requestAnimationFrame)",
    pattern: /\brequestAnimationFrame\s*\(/,
  },
  { rule: "schedules its own time (setTimeout)", pattern: /\bsetTimeout\s*\(/ },
  { rule: "schedules its own time (setInterval)", pattern: /\bsetInterval\s*\(/ },
  { rule: "renders DOM into exported pixels (<Html>)", pattern: /<Html\b/ },
  { rule: "references a remote asset", pattern: /["'`]https?:\/\// },
  { rule: "references an absolute asset path", pattern: /["'`]\/(?:Users|home|Volumes|tmp)\// },
];

/** Comments are prose, not code: a scene may explain WHY it never calls Date.now without tripping the gate. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

const files = Object.keys(sources)
  .map((path) => path.replace(/^(\.\.\/)+/, ""))
  .sort();

describe("scene-authoring hard rules", () => {
  it("covers the bundled, preset and fixture trees", () => {
    expect(files.some((f) => f.startsWith("projects/"))).toBe(true);
    expect(files.some((f) => f.startsWith("presets/"))).toBe(true);
    expect(files.some((f) => f.startsWith("fixtures/"))).toBe(true);
  });

  it.each(files)("%s drives motion from the timeline and keeps its assets local", (file) => {
    const path = Object.keys(sources).find((p) => p.endsWith(file));
    const code = stripComments(sources[path as string]);
    const broken = RULES.filter(({ pattern }) => pattern.test(code)).map(({ rule }) => rule);
    expect(broken).toEqual([]);
  });
});
