import type { ItemKind } from "./types";

export function packProjectItems(
  items: { kind: ItemKind; slug: string; name: string }[],
): { slug: string; name: string }[] {
  return items.flatMap(({ kind, slug, name }) => {
    if (kind === "project") return [{ slug, name }];
    if (kind === "template" || kind === "preset") {
      return [{ slug: `ws-${kind}:${slug}`, name }];
    }
    return [];
  });
}
