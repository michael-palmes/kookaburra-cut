/** The bridge `fonts` request (docs/agent-kit.md): vets font refs with the real parser in the render window. Placeholder until the font-safety work lands. */
export async function serveFontsRequest(_request: {
  refs?: string[];
  listFamilies?: boolean;
}): Promise<Record<string, unknown>> {
  return { ok: false, error: "font checks are not available in this build" };
}
