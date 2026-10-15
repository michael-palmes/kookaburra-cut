import { beforeEach, describe, expect, it, vi } from "vitest";

const preloaded: string[] = [];
vi.mock("troika-three-text", () => ({
  configureTextBuilder: vi.fn(),
  preloadFont: vi.fn((options: { font: string }, callback: () => void) => {
    preloaded.push(options.font);
    callback();
  }),
}));

const BAD = new Map<string, string>([
  ["asset://menlo.ttf", "unknown cmap table format 6"],
  ["asset://sfmono.otf", "error: unknown encoding format: 1"],
]);
const UNREADABLE = "asset://locked.ttf";
vi.mock("./fontVet", () => ({
  vetFontUrl: vi.fn(async (url: string) => {
    if (url === UNREADABLE) {
      return { ok: false, transient: true, error: "couldn't read the font file (HTTP 500)" };
    }
    return BAD.has(url) ? { ok: false, error: BAD.get(url) } : { ok: true };
  }),
}));

const pinned: { family: string; weight: number }[][] = [];
vi.mock("../engine/systemFonts", () => ({
  ensureFontRefsPinned: vi.fn(async (refs: { family: string; weight: number }[]) => {
    pinned.push(refs);
  }),
}));

const { validateFontRefs, vetProjectFonts } = await import("./fontSafety");
const { fontUrl, preloadAppFonts, registerWorkspaceFont, setFontSubstitute } = await import(
  "./fonts"
);

registerWorkspaceFont("Menlo", 400, "asset://menlo.ttf");
registerWorkspaceFont("SF Mono", 400, "asset://sfmono.otf");
registerWorkspaceFont("Futura", 700, "asset://futura.ttf");
registerWorkspaceFont("Georgia", 400, "asset://georgia.ttf");
registerWorkspaceFont("Locked", 400, UNREADABLE);

const futura = { family: "Futura", weight: 700 };
const georgia = { family: "Georgia", weight: 400 };
const menlo = { family: "Menlo", weight: 400 };
const sfMono = { family: "SF Mono", weight: 400 };

beforeEach(() => {
  for (const url of [...BAD.keys(), UNREADABLE]) setFontSubstitute(url, null);
  preloaded.length = 0;
  pinned.length = 0;
});

describe("vetProjectFonts", () => {
  it("marks an unreadable font file transient so deliverables refuse", async () => {
    const issues = await vetProjectFonts([{ family: "Locked", weight: 400 }], [futura]);
    expect(issues).toEqual([
      {
        ref: "Locked@400",
        message: "couldn't read the font file (HTTP 500)",
        fallback: "Futura@700",
        transient: true,
      },
    ]);
  });

  it("refuses to preload past an unreadable face instead of standing one in", async () => {
    await expect(preloadAppFonts([{ family: "Locked", weight: 400 }])).rejects.toThrow(
      /couldn't read the font file/,
    );
    expect(fontUrl({ family: "Locked", weight: 400 })).toBe(UNREADABLE);
  });

  it("swaps a failing sidecar face for the theme's nearest-weight face and names it", async () => {
    const issues = await vetProjectFonts([futura, georgia, menlo], [futura, georgia]);
    expect(issues).toEqual([
      { ref: "Menlo@400", message: "unknown cmap table format 6", fallback: "Georgia@400" },
    ]);
    expect(fontUrl(menlo)).toBe("asset://georgia.ttf");
    expect(fontUrl(futura)).toBe("asset://futura.ttf");
  });

  it("falls back to Inter when the theme's own face is the one that fails", async () => {
    const issues = await vetProjectFonts([sfMono], [sfMono, sfMono]);
    expect(issues).toEqual([
      { ref: "SF Mono@400", message: "error: unknown encoding format: 1", fallback: "Inter@400" },
    ]);
    expect(fontUrl(sfMono)).toBe(fontUrl({ family: "Inter", weight: 400 }));
  });

  it("names a family that resolves nowhere without changing what renders", async () => {
    const missing = { family: "Nowhere Sans", weight: 500 };
    const before = fontUrl(missing);
    const issues = await vetProjectFonts([missing], [futura]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ ref: "Nowhere Sans@500", fallback: "Inter@400" });
    expect(fontUrl(missing)).toBe(before);
  });

  it("leaves bundled and healthy faces alone", async () => {
    const issues = await vetProjectFonts(
      [{ family: "Inter", weight: 600 }, futura, georgia],
      [futura, georgia],
    );
    expect(issues).toEqual([]);
  });
});

describe("preloadAppFonts", () => {
  it("never hands troika a face its parser rejects", async () => {
    await preloadAppFonts([sfMono, futura]);
    expect(preloaded).not.toContain("asset://sfmono.otf");
    expect(preloaded).toContain("asset://futura.ttf");
    expect(fontUrl(sfMono)).toBe(fontUrl({ family: "Inter", weight: 400 }));
  });

  it("keeps the preload order for healthy faces", async () => {
    await preloadAppFonts([futura, georgia]);
    expect(preloaded.slice(1, 3)).toEqual(["asset://futura.ttf", "asset://georgia.ttf"]);
  });
});

describe("validateFontRefs", () => {
  it("reports each ref with the parser's verdict and the stand-in", async () => {
    const results = await validateFontRefs(["Menlo@400", "Inter@600", "Futura@700"]);
    expect(results).toEqual([
      {
        ref: "Menlo@400",
        ok: false,
        error: "unknown cmap table format 6",
        fallback: "Inter@400",
      },
      { ref: "Inter@600", ok: true },
      { ref: "Futura@700", ok: true },
    ]);
    expect(pinned).toEqual([[menlo, futura]]);
  });
});
