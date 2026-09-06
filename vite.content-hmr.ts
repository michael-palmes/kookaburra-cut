import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { type EnvironmentModuleNode, normalizePath, type Plugin } from "vite";

export function contentHmr(): Plugin {
  let root: string;
  const revisions = new Map<string, { timestamp: number; sequence: number }>();
  return {
    name: "kookaburra-content-hmr",
    apply: "serve",
    enforce: "post",
    configResolved(config) {
      root = config.root;
    },
    hotUpdate: {
      order: "post",
      async handler({ file, type, modules, timestamp, read }) {
        const path = normalizePath(relative(root, file));
        const theme = /^src\/theme\/builtin\/([^/]+)\.json$/.exec(path);
        if (theme) {
          for (const module of modules) this.environment.moduleGraph.invalidateModule(module);
          if (this.environment.name === "client") {
            try {
              this.environment.hot.send({
                type: "custom",
                event: "kookaburra:theme-document",
                data: {
                  id: theme[1],
                  content: type === "delete" ? null : JSON.parse(await read()),
                },
              });
            } catch {
              /* Keep the previous valid theme while an external write settles. */
            }
          }
          return [];
        }
        if (/^(presets|projects)\/[^/]+\/poster\.png\.\d+\.\d+\.tmp$/.test(path)) return [];
        const match =
          /^(presets|projects)\/([^/]+)\/(project\.json|preset\.json|template\.json|poster\.png|scenes\/[^/]+\.json|assets\/.+)$/.exec(
            path,
          );
        if (!match) return;
        const [, tree, slug, document] = match;
        if (
          tree === "projects" &&
          document !== "template.json" &&
          !existsSync(resolve(root, tree, slug, "template.json"))
        )
          return;

        // Keep fresh imports available while the app owns document updates and scene reloads.
        const invalidated = new Set<EnvironmentModuleNode>();
        for (const module of modules) {
          this.environment.moduleGraph.invalidateModule(module, invalidated, timestamp, true);
        }
        if (this.environment.name === "client") {
          const previous = revisions.get(path);
          if (previous && previous.timestamp > timestamp) return [];
          const revision = { timestamp, sequence: (previous?.sequence ?? 0) + 1 };
          revisions.set(path, revision);
          try {
            const content: unknown =
              type === "delete"
                ? null
                : document === "poster.png" || document.startsWith("assets/")
                  ? `/${path}?v=${timestamp}`
                  : JSON.parse(await read());
            if (revisions.get(path) !== revision) return [];
            this.environment.hot.send({
              type: "custom",
              event: "kookaburra:library-document",
              data: { path: `/${path}`, content },
            });
          } catch {
            // The project loader reports invalid documents; keep the last valid catalogue entry.
          }
        }
        return [];
      },
    },
  };
}
