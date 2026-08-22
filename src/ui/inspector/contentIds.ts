export function nextNumberedContentId(prefix: string, used: readonly string[]): string {
  const taken = new Set(used);
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}
