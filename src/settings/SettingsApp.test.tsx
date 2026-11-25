import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeStatus } from "../engine/claudeConsent";
import type { ManagedPolicy } from "../engine/managed";

const CLAUDE_ON: ClaudeStatus = {
  consent: true,
  allowed: true,
  reason: null,
  orgPolicy: "notRequired",
};

let policy: Partial<ManagedPolicy> = {};
let claude: ClaudeStatus = CLAUDE_ON;
let leftToInstaller = false;

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "claude_status") return claude;
    if (cmd === "updates_left_to_installer") return leftToInstaller;
    if (cmd !== "managed_policy") throw new Error(`unexpected command ${cmd}`);
    const { UNMANAGED } = await import("../engine/managed");
    return { ...UNMANAGED, ...policy };
  }),
}));

/** Settings as a managed Mac first paints it: the policy and the Claude answer are read before the window renders. */
async function render(forced: Partial<ManagedPolicy>, answer = CLAUDE_ON): Promise<string> {
  policy = { managed: true, ...forced };
  claude = answer;
  vi.resetModules();
  const managed = await import("../engine/managed");
  await managed.managedPolicy();
  const consent = await import("../engine/claudeConsent");
  await consent.claudeStatus();
  const updates = await import("../engine/updates");
  await updates.updatesLeftToInstaller();
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
  claude = CLAUDE_ON;
  leftToInstaller = false;
});

describe("Settings rows a profile governs", () => {
  it("shows every row with its own control on an unmanaged Mac", async () => {
    const html = await render({ managed: false });
    expect(html).not.toContain(LOCK);
    expect(row(html, "Agent kit")).toContain(">On<");
    expect(row(html, "Save exports to Downloads")).toContain('type="checkbox"');
    expect(row(html, "Check for updates automatically")).toContain("Asks GitHub");
    expect(html).not.toContain("Website data");
    expect(html).not.toContain("Live websites");
  });

  it("keeps Claude and the agent kit off until the switch is on", async () => {
    const unanswered = await render(
      { managed: false },
      {
        consent: null,
        allowed: false,
        reason: "Claude is off. Turn it on in Settings ▸ Claude",
        orgPolicy: "notRequired",
      },
    );
    const use = row(unanswered, "Use Claude");
    expect(use).toContain('type="checkbox"');
    expect(use).not.toContain("checked");
    expect(use).toContain("to Anthropic, under your own account");
    expect(row(unanswered, "Agent kit")).toContain(">Off<");
    expect(row(unanswered, "Show on a new project&#x27;s first open")).toContain("disabled");

    const on = row(await render({ managed: false }), "Use Claude");
    expect(on).toContain("checked");
  });

  it("locks Use Claude where the organisation's Claude settings are required and missing", async () => {
    const forced = { requireManagedClaude: true, forcedKeys: ["RequireManagedClaude"] };
    const missing = row(
      await render(forced, {
        consent: null,
        allowed: false,
        reason:
          "managed: Claude needs your organisation's Claude settings on this Mac (RequireManagedClaude).",
        orgPolicy: "missing",
      }),
      "Use Claude",
    );
    expect(missing).toContain(LOCK);
    expect(missing).toContain("(RequireManagedClaude)");
    expect(missing).toContain("Ask IT");
    expect(missing).not.toContain('type="checkbox"');

    const found = row(await render(forced, { ...CLAUDE_ON, orgPolicy: "found" }), "Use Claude");
    expect(found).not.toContain(LOCK);
    expect(found).toContain('type="checkbox"');
  });

  it("locks the Agent kit row and every Claude row under DisableAgentKit", async () => {
    const html = await render({ disableAgentKit: true, forcedKeys: ["DisableAgentKit"] });
    const kit = row(html, "Agent kit");
    expect(kit).toContain(LOCK);
    expect(kit).toContain("(DisableAgentKit)");
    expect(kit).toContain("<svg");
    expect(row(html, "Use Claude")).toContain(LOCK);
    expect(row(html, "Claude app")).toContain(LOCK);
    expect(row(html, "Show on a new project&#x27;s first open")).toContain(LOCK);
  });

  it("locks the Claude rows but leaves the kit on under DisableClaude alone", async () => {
    const html = await render({ disableClaude: true, forcedKeys: ["DisableClaude"] });
    expect(row(html, "Use Claude")).toContain("(DisableClaude)");
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

  it("leaves updates to the installer on a package install, without blaming a profile", async () => {
    leftToInstaller = true;
    const html = await render({ managed: false });
    const updates = row(html, "Check for updates automatically");
    expect(updates).toContain("Updated by its installer");
    expect(updates).toContain("never checks for updates itself");
    expect(updates).not.toContain(LOCK);
    expect(updates).not.toContain('type="checkbox"');
    const status = row(html, ">Status<");
    expect(status).toContain("updates arrive from the installer");
    expect(status).not.toContain("Check now");
  });

  it("locks the Publisher rows under DisablePackExport", async () => {
    const html = await render({ disablePackExport: true, forcedKeys: ["DisablePackExport"] });
    for (const title of ["Name", "Organisation", "Website", "Signing key"]) {
      expect(row(html, `>${title}<`), title).toContain("(DisablePackExport)");
    }
    expect(html).not.toContain('aria-label="Publisher name"');
  });

  it("offers Export log on every Mac, managed or not", async () => {
    for (const forced of [
      { managed: false },
      { disableClaude: true, forcedKeys: ["DisableClaude"] },
    ]) {
      const exportRow = row(await render(forced), "Export log");
      expect(exportRow).toContain("Export…");
      expect(exportRow).toContain("never what is in your files");
      expect(exportRow).not.toContain(LOCK);
      expect(exportRow).not.toContain("AuditLogPath");
    }
  });

  it("tells the person their organisation keeps a copy under AuditLogPath", async () => {
    const html = await render({
      auditLogPath: "/Library/Logs/Kookaburra Cut",
      forcedKeys: ["AuditLogPath"],
    });
    const exportRow = row(html, "Export log");
    expect(exportRow).toContain(
      "Your organisation&#x27;s profile asks for a copy of this log (AuditLogPath).",
    );
    expect(exportRow).toContain("Export…");
  });
});

describe("Settings › Accessibility", () => {
  it("offers Text size as four options, each with a leading icon", async () => {
    const html = await render({ managed: false });
    expect(html).toMatch(/<\/svg>Text size<\/span>/);
    const size = html.slice(html.indexOf("Text size<"), html.indexOf("Single-key shortcuts<"));
    expect(size).toContain('role="radiogroup" aria-label="Text size"');
    for (const label of ["Default", "Large", "Larger", "Largest"]) {
      expect(size).toMatch(new RegExp(`role="radio"[^>]*>\\s*<svg[^]*?</svg>${label}<`));
    }
    expect(size).toContain('aria-checked="true"');
  });

  it("offers Single-key shortcuts as a switch, on by default", async () => {
    const html = await render({ managed: false });
    expect(html).toMatch(/<\/svg>Single-key shortcuts<\/span>/);
    const keys = row(html, "Single-key shortcuts");
    expect(keys).toMatch(/type="checkbox" aria-label="Single-key shortcuts" checked=""/);
  });
});
