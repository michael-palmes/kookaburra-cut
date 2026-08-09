#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const comparePath = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function readCaptureContract(root) {
  const source = readFileSync(join(root, "src", "engine", "themePreviews.ts"), "utf8");
  const number = (name) => {
    const value = source.match(new RegExp(`export const ${name} = (\\d+)`))?.[1];
    if (!value) throw new Error(`theme-preview-stale: ${name} not found`);
    return Number(value);
  };
  const project = source.match(/THEME_PREVIEW_PROJECT_ID = "([^"]+)"/)?.[1];
  const sceneList = source.match(/THEME_PREVIEW_SCENES = \[([^\]]+)\]/)?.[1];
  if (!project || !sceneList) {
    throw new Error("theme-preview-stale: preview project or scene set not found");
  }
  const scenes = sceneList.split(",").map((value) => Number(value.trim()));
  if (scenes.some((value) => !Number.isInteger(value))) {
    throw new Error("theme-preview-stale: preview scene set is invalid");
  }
  return {
    // This is the explicit pin for renderer behaviour that cannot be fingerprinted as an asset.
    // Bump THEME_PREVIEW_VERSION whenever an engine change deliberately changes preview pixels.
    version: number("THEME_PREVIEW_VERSION"),
    project,
    scenes,
    count: number("THEME_PREVIEW_COUNT"),
    width: number("THEME_PREVIEW_WIDTH"),
  };
}

function readThemeLineup(root) {
  const themeDir = join(root, "src", "theme");
  const registry = readFileSync(join(themeDir, "registry.ts"), "utf8");
  const literal = registry.match(/THEME_LINEUP:[^=]+?= \[([\s\S]*?)\];/)?.[1];
  let lineup;
  if (literal) {
    lineup = [...literal.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  } else {
    const catalogue = readFileSync(join(themeDir, "catalogue.ts"), "utf8");
    const categoriesBlock = catalogue.match(/THEME_CATEGORIES = \[([\s\S]*?)\] as const/)?.[1];
    if (!categoriesBlock || !/THEME_LINEUP[^=]+=[\s\S]*filterThemeCatalogue/.test(catalogue)) {
      throw new Error("theme-preview-stale: THEME_LINEUP not found");
    }
    const categories = [...categoriesBlock.matchAll(/id: "([^"]+)"/g)].map((match) => match[1]);
    const rank = new Map(categories.map((category, index) => [category, index]));
    lineup = readdirSync(join(themeDir, "builtin"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(themeDir, "builtin", name), "utf8")))
      .filter((doc) => doc.catalogue?.hidden !== true)
      .sort((a, b) => {
        const category =
          (rank.get(a.catalogue?.category) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.catalogue?.category) ?? Number.MAX_SAFE_INTEGER);
        if (category !== 0) return category;
        const order =
          (a.catalogue?.order ?? Number.MAX_SAFE_INTEGER) -
          (b.catalogue?.order ?? Number.MAX_SAFE_INTEGER);
        if (order !== 0) return order;
        const compareText = (left, right) => {
          const aText = left.toLocaleLowerCase("en-AU");
          const bText = right.toLocaleLowerCase("en-AU");
          return aText < bText ? -1 : aText > bText ? 1 : 0;
        };
        const name = compareText(a.name, b.name);
        return name !== 0 ? name : compareText(a.id, b.id);
      })
      .map((doc) => doc.id);
  }
  if (lineup.length === 0 || new Set(lineup).size !== lineup.length) {
    throw new Error("theme-preview-stale: THEME_LINEUP is empty or contains duplicates");
  }
  return lineup;
}

function filesBelow(dir) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(dir);
  return files.sort((a, b) => comparePath(relative(dir, a), relative(dir, b)));
}

function fingerprintFixture(root, project) {
  const dir = join(root, "projects", project);
  const hash = createHash("sha256");
  for (const path of filesBelow(dir)) {
    hash.update(relative(dir, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function fingerprintPixelAssets(root) {
  const hash = createHash("sha256");
  const assetGroups = [
    {
      dir: join(root, "src", "assets", "fonts"),
      include: (path) => /\.(?:json|otf|ttf|woff2?)$/i.test(path),
    },
    {
      dir: join(root, "src", "assets", "backdrops"),
      include: (path) => /\.(?:avif|jpe?g|png|webp)$/i.test(path),
    },
  ];
  for (const { dir, include } of assetGroups) {
    if (!existsSync(dir)) continue;
    for (const path of filesBelow(dir).filter(include)) {
      hash.update(relative(root, path));
      hash.update("\0");
      hash.update(readFileSync(path));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

export function currentThemePreviewState(root = SCRIPT_ROOT, options = {}) {
  const capture = readCaptureContract(root);
  if (options.project) capture.project = options.project;
  const fixture = fingerprintFixture(root, capture.project);
  const pixelAssets = fingerprintPixelAssets(root);
  const lineup = readThemeLineup(root);
  const themes = new Map();
  for (const theme of lineup) {
    const themePath = join(root, "src", "theme", "builtin", `${theme}.json`);
    if (!existsSync(themePath)) {
      throw new Error(`theme-preview-stale: missing bundled theme ${theme}`);
    }
    const hash = createHash("sha256");
    hash.update(JSON.stringify(capture));
    hash.update("\0");
    hash.update(fixture);
    hash.update("\0");
    hash.update(pixelAssets);
    hash.update("\0");
    hash.update(readFileSync(themePath));
    themes.set(theme, hash.digest("hex"));
  }
  return { capture, lineup, themes };
}

function manifestPath(root) {
  return join(root, "src", "assets", "theme-previews", "manifest.json");
}

function readManifest(root) {
  try {
    return JSON.parse(readFileSync(manifestPath(root), "utf8"));
  } catch {
    return {};
  }
}

function writeManifest(root, capture, themes) {
  const path = manifestPath(root);
  const assets = dirname(path);
  mkdirSync(assets, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ capture, themes }, null, 2)}\n`);
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

function previewSetExists(root, theme, count) {
  const dir = join(root, "src", "assets", "theme-previews");
  return Array.from({ length: count }, (_, index) =>
    existsSync(join(dir, `${theme}-${index + 1}.jpg`)),
  ).every(Boolean);
}

export function staleThemePreviews(root = SCRIPT_ROOT, options = {}) {
  const current = currentThemePreviewState(root, options);
  const manifest = readManifest(root);
  return current.lineup.filter(
    (theme) =>
      !previewSetExists(root, theme, current.capture.count) ||
      manifest.themes?.[theme] !== current.themes.get(theme),
  );
}

function retainedThemes(current, previous) {
  return Object.fromEntries(
    current.lineup
      .filter((theme) => previous.themes?.[theme])
      .map((theme) => [theme, previous.themes[theme]]),
  );
}

function removeOrphanAssets(root, current) {
  const assets = dirname(manifestPath(root));
  mkdirSync(assets, { recursive: true });
  const expected = new Set(
    current.lineup.flatMap((theme) =>
      Array.from({ length: current.capture.count }, (_, index) => `${theme}-${index + 1}.jpg`),
    ),
  );
  let removed = 0;
  for (const entry of readdirSync(assets, { withFileTypes: true })) {
    const isOrphanPreview =
      entry.isFile() && entry.name.endsWith(".jpg") && !expected.has(entry.name);
    const isPromotionTemporary =
      entry.isFile() && entry.name.startsWith(".theme-preview-") && entry.name.endsWith(".tmp");
    if (isOrphanPreview || isPromotionTemporary) {
      unlinkSync(join(assets, entry.name));
      removed++;
    }
  }
  return removed;
}

function orderedThemes(themes) {
  return Object.fromEntries(Object.entries(themes).sort(([a], [b]) => comparePath(a, b)));
}

export function cleanupThemePreviews(root = SCRIPT_ROOT, options = {}) {
  const current = currentThemePreviewState(root, options);
  const previous = readManifest(root);
  const themes = orderedThemes(retainedThemes(current, previous));
  const removed = removeOrphanAssets(root, current);
  const removedEntries = Object.keys(previous.themes ?? {}).filter(
    (theme) => !current.themes.has(theme),
  ).length;
  writeManifest(root, current.capture, themes);
  return { removed, removedEntries };
}

export function invalidateThemePreviews(root = SCRIPT_ROOT, captured = [], options = {}) {
  const current = currentThemePreviewState(root, options);
  const unknown = captured.filter((theme) => !current.themes.has(theme));
  if (unknown.length > 0) {
    throw new Error(`theme-preview-stale: unknown captured theme(s): ${unknown.join(", ")}`);
  }
  const themes = retainedThemes(current, readManifest(root));
  for (const theme of captured) delete themes[theme];
  const removed = removeOrphanAssets(root, current);
  writeManifest(root, current.capture, orderedThemes(themes));
  return { invalidated: captured.length, removed };
}

export function commitThemePreviews(root = SCRIPT_ROOT, captured = [], options = {}) {
  const current = currentThemePreviewState(root, options);
  const unknown = captured.filter((theme) => !current.themes.has(theme));
  if (unknown.length > 0) {
    throw new Error(`theme-preview-stale: unknown captured theme(s): ${unknown.join(", ")}`);
  }
  const previous = readManifest(root);
  const themes = retainedThemes(current, previous);
  for (const theme of captured) {
    if (!previewSetExists(root, theme, current.capture.count)) {
      throw new Error(`theme-preview-stale: incomplete preview set for ${theme}`);
    }
    themes[theme] = current.themes.get(theme);
  }
  const removed = removeOrphanAssets(root, current);
  writeManifest(root, current.capture, orderedThemes(themes));
  return { committed: captured.length, removed };
}

function runCli() {
  const mode = process.argv[2];
  const args = process.argv.slice(3);
  const projectIndex = args.indexOf("--project");
  const project = projectIndex >= 0 ? args[projectIndex + 1] : undefined;
  if (projectIndex >= 0) {
    if (!project) throw new Error("theme-preview-stale: --project needs an id");
    args.splice(projectIndex, 2);
  }
  if (mode === "list") {
    process.stdout.write(staleThemePreviews(SCRIPT_ROOT, { project }).join(","));
    return;
  }
  if (mode === "cleanup") {
    const result = cleanupThemePreviews(SCRIPT_ROOT, { project });
    if (result.removed > 0 || result.removedEntries > 0) {
      process.stdout.write(
        `manifest: removed ${result.removed} orphan preview(s) and ${result.removedEntries} orphan entry(s)\n`,
      );
    }
    return;
  }
  if (mode === "invalidate") {
    const result = invalidateThemePreviews(SCRIPT_ROOT, args, { project });
    process.stdout.write(`manifest: ${result.invalidated} theme(s) invalidated\n`);
    return;
  }
  if (mode === "commit") {
    const result = commitThemePreviews(SCRIPT_ROOT, args, { project });
    process.stdout.write(
      `manifest: ${result.committed} theme(s) committed, ${result.removed} orphan preview(s) removed\n`,
    );
    return;
  }
  console.error(
    "usage: theme-preview-stale.mjs list|cleanup [--project id] | invalidate|commit [--project id] <theme...>",
  );
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
