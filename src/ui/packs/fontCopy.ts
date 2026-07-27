/** Font wording for the pack export and import screens. It is a legal surface as much as a UI one, so it lives in one place: the app checks what the font file permits, never what the user's licence permits, and the copy has to say so. */

/** OS/2 fsType, decoded by `src-tauri/src/fonts.rs`. Unknown gates as preview-and-print: a missing OS/2 table is usually an old free face. */
export type FontEmbedding = "installable" | "editable" | "preview-print" | "restricted" | "unknown";

/** Shown once per export that includes any font at all. */
export const FONT_DISCLAIMER =
  "Fonts you include are copied into the pack and sent to whoever opens it. You are responsible for holding a licence that allows that. Kookaburra Cut checks what the font file itself permits, which is not the same as your licence agreement.";

export const restrictedFontNotice = (family: string): string =>
  `${family} is licensed in a way that does not allow it to be shared. The pack will reference it by name, and people who open it will need it installed.`;

export const limitedFontNotice = (family: string): string =>
  `${family} allows limited embedding. Check your licence before sharing this pack.`;

/** The one-line note for a face, or null when nothing needs saying. */
export function fontEmbeddingNotice(family: string, embedding: FontEmbedding): string | null {
  if (embedding === "restricted") return restrictedFontNotice(family);
  if (embedding === "preview-print" || embedding === "unknown") return limitedFontNotice(family);
  return null;
}

/** Short label for a font row. */
export const FONT_EMBEDDING_LABEL: Record<FontEmbedding, string> = {
  installable: "Can be shared",
  editable: "Can be shared",
  "preview-print": "Limited licence",
  unknown: "Licence unknown",
  restricted: "Cannot be shared",
};

/** Restricted faces travel as a name only; everything else travels as bytes. */
export const canBundleFont = (embedding: FontEmbedding): boolean => embedding !== "restricted";
