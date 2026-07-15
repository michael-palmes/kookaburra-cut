// The singleton seam for runtime-compiled user scenes: a compiled workspace scene must resolve its bare imports to the APP'S module instances (a second react or three breaks hooks and the one-canvas contract), so the app publishes its live namespace objects here and each allowed specifier materialises as a generated blob-URL ES module, never a hand-maintained list, so a new toolkit export is automatically available to user scenes. See docs/decisions.md ("Studio, workspace & packaged app" > "The compile seam").

import * as jsxRuntime from "react/jsx-runtime";
import * as toolkit from "../toolkit";
import { registryModuleSource } from "./moduleRegistrySource";

declare global {
  var __KOOKABURRA_MODULES__: Record<string, Record<string, unknown>> | undefined;
}

/** The full import surface of a user scene (locked decision 2: single-file, toolkit-only). `react/jsx-runtime` is what esbuild's automatic JSX transform emits; user code never writes it. Anything else is an authoring error. */
const registry: Record<string, Record<string, unknown>> = {
  "@kookaburra/toolkit": toolkit as unknown as Record<string, unknown>,
  "react/jsx-runtime": jsxRuntime as unknown as Record<string, unknown>,
};

/** Lazily-created blob URLs, one per specifier, shared by every compiled scene. */
const moduleUrls = new Map<string, string>();

/** The blob-module URL a compiled scene's import of `specifier` rewrites to, or null when the specifier isn't in the allowed surface (the compiler turns that into a readable authoring error). */
export function registryModuleUrl(specifier: string): string | null {
  const ns = registry[specifier];
  if (!ns) return null;
  let url = moduleUrls.get(specifier);
  if (!url) {
    globalThis.__KOOKABURRA_MODULES__ ??= {};
    globalThis.__KOOKABURRA_MODULES__[specifier] = ns;
    url = URL.createObjectURL(
      new Blob([registryModuleSource(specifier, ns)], { type: "text/javascript" }),
    );
    moduleUrls.set(specifier, url);
  }
  return url;
}

/** The allowed specifiers, for error messages ("expected one of …"). */
export function allowedSpecifiers(): string[] {
  return Object.keys(registry).sort();
}
