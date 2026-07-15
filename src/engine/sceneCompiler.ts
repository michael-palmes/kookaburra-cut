// Packaged app has no Vite, so workspace scenes compile at runtime via esbuild-wasm; a resolve plugin restricts imports to toolkit-only blob-module URLs (locked decision 2). See docs/decisions.md ("Studio, workspace & packaged app").

import type { Plugin } from "esbuild-wasm";
import wasmURL from "esbuild-wasm/esbuild.wasm?url";
import { allowedSpecifiers, registryModuleUrl } from "./moduleRegistry";

// Lazy init: bundled-project sessions never pay this cost; main-thread because packaged WKWebView refuses blob workers over tauri:// (the troika lesson, docs/determinism.md "Packaged-app parity"), and compiles are only tens of ms.
let esbuildReady: Promise<typeof import("esbuild-wasm")> | null = null;
function ensureEsbuild(): Promise<typeof import("esbuild-wasm")> {
  esbuildReady ??= (async () => {
    const esbuild = await import("esbuild-wasm");
    await esbuild.initialize({ wasmURL, worker: false });
    return esbuild;
  })();
  return esbuildReady;
}

/** The import-rewrite plugin: allowed specifiers become external blob URLs. */
const registryResolver: Plugin = {
  name: "kookaburra-registry",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      const url = registryModuleUrl(args.path);
      if (url) return { path: url, external: true };
      return {
        errors: [
          {
            text:
              `user scenes may import only ${allowedSpecifiers().join(", ")} — ` +
              `got "${args.path}". Scenes are single-file and toolkit-only ` +
              "(see the kookaburra-scene-authoring skill).",
          },
        ],
      };
    });
  },
};

/** Compiles one workspace scene module to a loadable blob URL; deterministic because esbuild-wasm is pinned and pure, and errors carry esbuild's line/column diagnostics so a broken edit reads as an actionable scene error. */
export async function compileSceneModule(source: string, sourcefile: string): Promise<string> {
  const esbuild = await ensureEsbuild();
  let js: string;
  try {
    const result = await esbuild.build({
      stdin: { contents: source, loader: "tsx", sourcefile },
      bundle: true,
      write: false,
      format: "esm",
      target: "es2022",
      jsx: "automatic",
      logLevel: "silent",
      plugins: [registryResolver],
    });
    js = result.outputFiles[0].text;
  } catch (e) {
    throw new Error(formatBuildError(sourcefile, e), { cause: e });
  }
  return URL.createObjectURL(new Blob([js], { type: "text/javascript" }));
}

/** esbuild aggregate errors → one readable message with locations. */
function formatBuildError(sourcefile: string, e: unknown): string {
  const errors = (e as { errors?: { text: string; location?: { line: number } | null }[] })?.errors;
  if (!errors?.length) return `Scene "${sourcefile}" failed to compile: ${e}`;
  const details = errors
    .map((err) => (err.location ? `line ${err.location.line}: ${err.text}` : err.text))
    .join("\n  ");
  return `Scene "${sourcefile}" failed to compile:\n  ${details}`;
}
