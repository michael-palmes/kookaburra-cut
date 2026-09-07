// Pure codegen half of the module registry: import-free so unit tests don't drag the toolkit (three/r3f/troika) into the node test env. The registry itself (namespace publishing + blob URLs) is engine/moduleRegistry.ts.

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Source of a registry module: re-exports every named export of `ns` by reading off the global registry at module-eval time. Sorted names keep the emitted code canonical; non-identifier keys (never produced by the toolkit) are skipped rather than emitted as broken syntax. */
export function registryModuleSource(specifier: string, ns: Record<string, unknown>): string {
  const names = Object.keys(ns)
    .filter((n) => n !== "default" && IDENTIFIER.test(n))
    .sort();
  const lines = [
    `const m = globalThis.__KOOKABURRA_MODULES__[${JSON.stringify(specifier)}];`,
    ...names.map((n) => `export const ${n} = m.${n};`),
  ];
  if ("default" in ns) lines.push("export default m.default;");
  return `${lines.join("\n")}\n`;
}
