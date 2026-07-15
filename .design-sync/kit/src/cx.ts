/** Join class names, dropping falsy entries. Internal — not part of the kit surface. */
export function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
