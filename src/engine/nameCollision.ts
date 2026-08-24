import { slugifyName } from "./workspace";

export interface NameCollisionOptions {
  /** A slug to ignore, so renaming something to its own name never warns. */
  selfSlug?: string | null;
  /** Slug rules for the target folder; defaults to the workspace rules. */
  slugify?: (name: string) => string;
}

export interface NameCollisionResult {
  /** The slug the typed name saves as, empty when the name has no letters or digits. */
  slug: string;
  collides: boolean;
}

function normalise(slug: string): string {
  return slug.trim().toLowerCase();
}

/** Does a typed name land on a slug that already exists? Shared by the naming prompts so a clash shows as you type, not a step later from the native error. */
export function nameCollision(
  name: string,
  existingSlugs: Iterable<string>,
  options: NameCollisionOptions = {},
): NameCollisionResult {
  const slug = (options.slugify ?? slugifyName)(name);
  if (!slug) return { slug: "", collides: false };
  const target = normalise(slug);
  const self = options.selfSlug ? normalise(options.selfSlug) : "";
  for (const existing of existingSlugs) {
    const candidate = normalise(existing);
    if (!candidate || candidate === self) continue;
    if (candidate === target) return { slug, collides: true };
  }
  return { slug, collides: false };
}

/** One-sentence warning copy, shared so every flow reads the same. */
export function nameCollisionWarning(noun: string, slug: string): string {
  return `A ${noun} named “${slug}” already exists.`;
}
