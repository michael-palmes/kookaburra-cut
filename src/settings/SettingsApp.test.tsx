import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedPolicy } from "../engine/managed";

let policy: Partial<ManagedPolicy> = {};

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (cmd: string) => {
    if (cmd !== "managed_policy") throw new Error(`unexpected command ${cmd}`);
    const { UNMANAGED } = await import("../engine/managed");
    return { ...UNMANAGED, ...policy };
  }),
}));

/** Settings as a managed Mac first paints it: the policy is read before the window renders. */
async function render(forced: Partial<ManagedPolicy>): Promise<string> {
  policy = { managed: true, ...forced };
  vi.resetModules();
  const managed = await import("../engine/managed");
  await managed.managedPolicy();
  const { SettingsApp } = await import("./SettingsApp");
  return renderToStaticMarkup(<SettingsApp />);
}

/** The row whose title is `title`, up to the next row. */
function row(html: string, title: string): string {
  const at = html.indexOf(title);
  expect(at, title).toBeGreaterThan(-1);
  const end = html.indexOf('class="settings-row', at);
  return html.slice(at, end === -1 ? undefined : end);
}

const LOCK = "Managed by your organisation";

beforeEach(() => {
  policy = {};
});

describe("Settings rows a profile governs", () => {
  it("shows every row with its own control on an unmanaged Mac", async () => {
    const html = await render({ managed: false });
    expect(html).not.toContain(LOCK);
    expect(row(html, "Agent kit")).toContain(">On<");
    expect(row(html, "Save exports to Downloads")).toContain('type="checkbox"');
    expect(row(html, "Check for updates automatically")).toContain("Asks GitHub");
  });

  it("locks the Agent kit row and every Claude row under DisableAgentKit", async () => {
    const html = await render({ disableAgentKit: true, forcedKeys: ["DisableAgentKit"] });
    const kit = row(html, "Agent kit");
    expect(kit).toContain(LOCK);
    expect(kit).toContain("(DisableAgentKit)");
    expect(kit).toContain("<svg");
    expect(row(html, "Claude app")).toContain(LOCK);
    expect(row(html, "Show on a new project&#x27;s first open")).toContain(LOCK);
  });

  it("locks the Claude rows but leaves the kit on under DisableClaude alone", async () => {
    const html = await render({ disableClaude: true, forcedKeys: ["DisableClaude"] });
    expect(row(html, "Claude app")).toContain("(DisableClaude)");
    expect(row(html, "Agent kit")).toContain(">On<");
  });

  it("locks Save exports to Downloads under ExportsInProject", async () => {
    const html = await render({ exportsInProject: true, forcedKeys: ["ExportsInProject"] });
    const downloads = row(html, "Save exports to Downloads");
    expect(downloads).toContain(LOCK);
    expect(downloads).toContain("(ExportsInProject)");
    expect(downloads).not.toContain('type="checkbox"');
  });

  it("names the organisation's server for a usable UpdateEndpoint", async () => {
    const html = await render({
      updateEndpoint: "https://updates.example.com/kc/latest.json",
      updateEndpointLocked: true,
      forcedKeys: ["UpdateEndpoint"],
    });
    const updates = row(html, "Check for updates automatically");
    expect(updates).toContain("your organisation&#x27;s update server");
    expect(updates).not.toContain(LOCK);
  });

  it("locks Updates with the reason when UpdateEndpoint is forced but unusable", async () => {
    const html = await render({ updateEndpointLocked: true, forcedKeys: ["UpdateEndpoint"] });
    expect(row(html, "Check for updates automatically")).toContain("(UpdateEndpoint)");
    expect(row(html, "Status")).toContain("update server address can&#x27;t be used");
  });

  it("locks the Publisher rows under DisablePackExport", async () => {
    const html = await render({ disablePackExport: true, forcedKeys: ["DisablePackExport"] });
    for (const title of ["Name", "Organisation", "Website", "Signing key"]) {
      expect(row(html, `>${title}<`), title).toContain("(DisablePackExport)");
    }
    expect(html).not.toContain('aria-label="Publisher name"');
  });
});
