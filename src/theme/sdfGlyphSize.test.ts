import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PIN = "SDF_GLYPH_SIZE";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** Blanks comments (keeping offsets and newlines) so prose that mentions `<Text>` is not a site. */
function stripComments(src: string): string {
  const out = src.split("");
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      const end = src[i + 1] === "/" ? src.indexOf("\n", i) : src.indexOf("*/", i + 2) + 2;
      const stop = end <= 1 ? src.length : end;
      for (let j = i; j < stop; j++) if (out[j] !== "\n") out[j] = " ";
      i = stop - 1;
    }
  }
  return out.join("");
}

/** The text from `open` up to its matching close, skipping nested pairs and string literals. */
function balanced(src: string, start: number, open: string, close: string): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${open}${close} at ${start}`);
}

/** A JSX opening tag from `<` to its closing `>`, ignoring any `>` inside `{...}` attribute expressions. */
function openingTag(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated tag at ${start}`);
}

function importedName(src: string, from: string, name: string): string | null {
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"${from.replace("/", "\\/")}"`, "g");
  for (const m of src.matchAll(re)) {
    for (const part of m[1].split(",")) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (orig === name) return alias ?? orig;
    }
  }
  return null;
}

interface Site {
  file: string;
  line: number;
  text: string;
}

function sites(): { jsx: Site[]; constructed: Site[]; calls: Site[] } {
  const jsx: Site[] = [];
  const constructed: Site[] = [];
  const calls: Site[] = [];
  for (const path of [...sources(join(ROOT, "src")), ...sources(join(ROOT, "tools"))]) {
    const src = stripComments(readFileSync(path, "utf8"));
    const file = relative(ROOT, path);
    const at = (i: number) => src.slice(0, i).split("\n").length;
    const dreiText = importedName(src, "@react-three/drei", "Text");
    if (dreiText) {
      for (const m of src.matchAll(new RegExp(`<${dreiText}[\\s>/]`, "g"))) {
        jsx.push({ file, line: at(m.index), text: openingTag(src, m.index) });
      }
    }
    const troikaText = importedName(src, "troika-three-text", "Text");
    if (troikaText) {
      for (const m of src.matchAll(new RegExp(`new ${troikaText}\\(`, "g"))) {
        const end = src.indexOf(".sync(", m.index);
        constructed.push({ file, line: at(m.index), text: src.slice(m.index, end) });
      }
    }
    for (const fn of ["preloadFont", "configureTextBuilder"]) {
      const local = importedName(src, "troika-three-text", fn);
      if (!local) continue;
      for (const m of src.matchAll(new RegExp(`\\b${local}\\(`, "g"))) {
        const open = m.index + local.length;
        calls.push({ file, line: at(m.index), text: balanced(src, open, "(", ")") });
      }
    }
  }
  return { jsx, constructed, calls };
}

const where = (s: Site) => `${s.file}:${s.line}`;

describe("one SDF atlas: every troika site pins SDF_GLYPH_SIZE", () => {
  const found = sites();

  it("finds the sites it guards", () => {
    expect(found.jsx.length).toBeGreaterThanOrEqual(12);
    expect(found.constructed.length).toBeGreaterThanOrEqual(1);
    expect(found.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("every drei <Text> passes sdfGlyphSize={SDF_GLYPH_SIZE}", () => {
    const missing = found.jsx.filter((s) => !s.text.includes(`sdfGlyphSize={${PIN}}`));
    expect(missing.map(where)).toEqual([]);
  });

  it("every constructed troika Text sets sdfGlyphSize before it syncs", () => {
    const missing = found.constructed.filter((s) => !s.text.includes(`.sdfGlyphSize = ${PIN}`));
    expect(missing.map(where)).toEqual([]);
  });

  it("the builder config and every preload name the same size", () => {
    const missing = found.calls.filter((s) => !s.text.includes(`sdfGlyphSize: ${PIN}`));
    expect(missing.map(where)).toEqual([]);
  });
});
