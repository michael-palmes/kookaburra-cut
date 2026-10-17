import { invoke } from "@tauri-apps/api/core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

const env = (overrides: Record<string, string | boolean | null>) => ({
  action: null,
  project: "showcase-tour",
  aspect: null,
  codec: null,
  preset: null,
  encodeJson: null,
  scene: null,
  at: null,
  sets: null,
  themes: null,
  stills: null,
  stillsSize: null,
  cold: false,
  ...overrides,
});

/** A fresh module per case: the env is prefetched once per page load. */
async function configFor(overrides: Record<string, string | boolean | null>) {
  vi.resetModules();
  vi.mocked(invoke).mockResolvedValue(env(overrides));
  const autorun = await import("./autorun");
  await autorun.initAutoRunConfig();
  return () => autorun.getAutoRunConfig();
}

// Transform the module graph once outside the 5 s test timeout, which a cold transform under load can exceed.
beforeAll(async () => {
  await import("./autorun");
}, 30_000);

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("stills autorun config", () => {
  it("defaults to a 1080p PDF at 16:9", async () => {
    const config = (await configFor({ action: "stills" }))();
    expect(config).toMatchObject({ action: "stills", stills: "pdf", stillsSize: "1080p" });
    expect(config?.aspects.map((a) => a.name)).toEqual(["16:9"]);
  });

  it("reads png as the PNG zip and an explicit size and aspect", async () => {
    const config = (
      await configFor({ action: "stillsverify", stills: "png", stillsSize: "720p", aspect: "9:16" })
    )();
    expect(config).toMatchObject({ stills: "png-zip", stillsSize: "720p" });
    expect(config?.aspects.map((a) => a.name)).toEqual(["9:16"]);
  });

  it("accepts a project list, like verify", async () => {
    const config = (await configFor({ action: "stills", project: "a,b" }))();
    expect(config?.projects).toEqual(["a", "b"]);
  });

  it("rejects an unknown format or size", async () => {
    expect(await configFor({ action: "stills", stills: "tiff" })).toThrow(
      'unknown KOOKABURRA_STILLS "tiff"',
    );
    expect(await configFor({ action: "stills", stillsSize: "8k" })).toThrow(
      'unknown KOOKABURRA_STILLS_SIZE "8k"',
    );
  });
});

describe("cold autorun", () => {
  it("holds the preview stand-down from boot only when asked", async () => {
    await configFor({ action: "verify", cold: true });
    expect((await import("./exportState")).isExporting()).toBe(true);
    await configFor({ action: "verify" });
    expect((await import("./exportState")).isExporting()).toBe(false);
  });

  it("reports the hold in the result only when it was taken", async () => {
    const resultOf = async (cold: boolean) => {
      await configFor({ action: "verify", cold });
      vi.mocked(invoke).mockClear();
      (await import("./autorun")).reportAutoRunError("boom");
      await vi.waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("finish_autorun", expect.anything()),
      );
      const [, args] = vi.mocked(invoke).mock.calls[0] as [string, { resultJson: string }];
      return JSON.parse(args.resultJson);
    };
    expect(await resultOf(true)).toMatchObject({ ok: false, cold: true });
    expect(await resultOf(false)).not.toHaveProperty("cold");
  });
});

describe("headless kb export knobs", () => {
  /** The env for get_autorun_config, and the modal's poster setting for get_settings. */
  async function configWith(
    overrides: Record<string, string | boolean | null>,
    disableOpeningPosterFrame?: boolean,
  ) {
    vi.resetModules();
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "get_settings" ? { disableOpeningPosterFrame } : env(overrides),
    );
    const autorun = await import("./autorun");
    await autorun.initAutoRunConfig();
    return autorun.getAutoRunConfig();
  }

  it("keeps the frozen path unless a poster frame is asked for", async () => {
    expect((await configWith({ action: "export" }))?.encode).toBeUndefined();
    expect((await configWith({ action: "export", poster: "off" }))?.encode).toBeUndefined();
    const on = await configWith({ action: "export", poster: "on" });
    expect(on?.encode?.posterFrame).toBe(true);
    expect(on?.outputSuffix).toBeUndefined();
  });

  it("reads the modal's setting for app, and adds the poster frame to a preset", async () => {
    expect((await configWith({ action: "verify", poster: "app" }))?.encode?.posterFrame).toBe(true);
    expect((await configWith({ action: "verify", poster: "app" }, true))?.encode).toBeUndefined();
    const preset = await configWith({ action: "export", poster: "on", preset: "share-h264" });
    expect(preset?.encode).toMatchObject({ codec: "libx264", posterFrame: true });
    expect(preset?.outputSuffix).toBe("share-h264");
    expect((await configWith({ action: "screenshot", poster: "on" }))?.encode).toBeUndefined();
  });

  it("refuses an unknown poster value and passes the progress flag through", async () => {
    await expect(configWith({ action: "export", poster: "maybe" })).rejects.toThrow(
      'unknown KOOKABURRA_POSTER "maybe"',
    );
    expect((await configWith({ action: "export", progress: true }))?.progress).toBe(true);
    expect((await configWith({ action: "export" }))?.progress).toBe(false);
  });

  it("tells kb a stored-only run needs the user's trust", async () => {
    await configWith({ action: "export", trust: "stored-only" });
    vi.mocked(invoke).mockClear();
    const { NeedsTrustError } = await import("./projectTrust");
    (await import("./autorun")).reportAutoRunError(new NeedsTrustError("demo"));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("finish_autorun", expect.anything()),
    );
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "finish_autorun");
    const args = call?.[1] as { resultJson: string } | undefined;
    const result = JSON.parse(args?.resultJson ?? "null");
    expect(result).toMatchObject({ ok: false, needsTrust: true });
    expect(result.error).toMatch(/^Project "demo" has code Kookaburra Cut has not allowed yet/);
  });
});
