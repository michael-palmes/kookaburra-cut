interface DocumentUpdate {
  path: string;
  content: unknown;
}

export function watchLibraryDocuments(
  hot: ImportMeta["hot"],
  tree: "presets" | "projects",
  documents: Record<string, Record<string, unknown>>,
  changed: (path: string) => void,
): void {
  if (!hot) return;
  const update = ({ path, content }: DocumentUpdate) => {
    if (!path.startsWith(`/${tree}/`)) return;
    const relative = path.slice(`/${tree}/`.length).split("/").slice(1).join("/");
    const collection = documents[relative.includes("/") ? relative.split("/")[0] : relative];
    if (!collection) return;
    if (content === null) delete collection[path];
    else collection[path] = content;
    changed(path);
  };
  hot.on("kookaburra:library-document", update);
  hot.dispose(() => hot.off("kookaburra:library-document", update));
}
