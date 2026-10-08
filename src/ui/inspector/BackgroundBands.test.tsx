import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BandedDrillBody,
  BgTypeStrip,
  LookBrowser,
  LookGroup,
  OptionsSheet,
  PresetDivider,
  PresetStrip,
  PresetSwatch,
  SheetColours,
  SheetDivider,
  SheetRow,
  SheetSlider,
  sheetPeek,
  stepDecimals,
} from "./BackgroundBands";

const noop = () => undefined;
const TYPES = [
  { id: "none", label: "None", icon: <svg data-icon="none" /> },
  { id: "color", label: "Colour", icon: <svg data-icon="color" /> },
  { id: "scene3d", label: "3D", icon: <svg data-icon="scene3d" /> },
] as const;

describe("BgTypeStrip", () => {
  it("renders icon-only tabs named by their type", () => {
    const html = renderToStaticMarkup(
      <BgTypeStrip
        ariaLabel="Background fill type"
        options={TYPES}
        value="scene3d"
        onSelect={noop}
      />,
    );

    expect(html).toContain(
      'class="bg-type-strip" role="tablist" aria-label="Background fill type"',
    );
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Colour" title="Colour"');
    expect(html).toContain('data-icon="scene3d"');
    expect(html).not.toMatch(/<button[^>]*>[^<]*Colour/);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toMatch(
      /class="bg-type-strip-tab selected" aria-selected="true" aria-label="3D" title="3D" tabindex="0"/,
    );
  });

  it("keeps one tab stop: the selected tab, else the first", () => {
    const selected = renderToStaticMarkup(
      <BgTypeStrip ariaLabel="Fill" options={TYPES} value="color" onSelect={noop} />,
    );
    expect(selected.match(/tabindex="0"/g)).toHaveLength(1);
    expect(selected).toMatch(/aria-label="Colour" title="Colour" tabindex="0"/);
    expect(selected.match(/tabindex="-1"/g)).toHaveLength(2);

    const none = renderToStaticMarkup(
      <BgTypeStrip ariaLabel="Fill" options={TYPES} value={null} onSelect={noop} />,
    );
    expect(none).not.toContain('aria-selected="true"');
    expect(none.match(/tabindex="0"/g)).toHaveLength(1);
    expect(none).toMatch(/aria-label="None" title="None" tabindex="0"/);
  });
});

describe("banded layout", () => {
  it("marks the drill body as banded so each band owns its overflow", () => {
    expect(renderToStaticMarkup(<BandedDrillBody>x</BandedDrillBody>)).toBe(
      '<div class="inspector-drill-body banded">x</div>',
    );
  });

  it("renders the look browser as a labelled region of family groups", () => {
    const html = renderToStaticMarkup(
      <LookBrowser selectedId="b" ariaLabel="3D looks">
        <LookGroup name="Grids and fields">
          <span>a</span>
        </LookGroup>
        <LookGroup>
          <span>b</span>
        </LookGroup>
      </LookBrowser>,
    );

    expect(html).toMatch(/^<section class="bg-look-browser" aria-label="3D looks">/);
    expect(html).toContain(
      '<div class="bg-look-group"><div class="bg-look-group-header">Grids and fields</div><div class="bg-look-grid"><span>a</span></div></div>',
    );
    expect(html).toContain(
      '<div class="bg-look-group"><div class="bg-look-grid"><span>b</span></div></div>',
    );
    expect(html.match(/bg-look-group-header/g)).toHaveLength(1);
  });

  it("heads the presets strip with the selected preset's name", () => {
    const html = renderToStaticMarkup(
      <PresetStrip selectedName="Mallee">
        <PresetDivider />
      </PresetStrip>,
    );

    expect(html).toContain('class="bg-preset-strip-title">Presets</span>');
    expect(html).toContain('class="bg-preset-strip-name" title="Mallee">Mallee</span>');
    expect(html).toContain(
      '<div class="bg-preset-strip-row"><span class="bg-preset-divider" aria-hidden="true"></span></div>',
    );
    expect(renderToStaticMarkup(<PresetStrip selectedName={null}>x</PresetStrip>)).not.toContain(
      "bg-preset-strip-name",
    );
  });

  it("paints a preset swatch as a pressed button with the still as its background", () => {
    const html = renderToStaticMarkup(
      <PresetSwatch
        name="Mulga"
        image="/previews/bgp-dust-drift-p2.jpg"
        fallback="#f9eee0"
        selected
        onSelect={noop}
      />,
    );

    expect(html).toMatch(/^<button type="button" class="bg-preset-swatch selected"/);
    expect(html).toContain('title="Mulga" aria-label="Preset Mulga" aria-pressed="true"');
    expect(html).toContain("background-image:url(&quot;/previews/bgp-dust-drift-p2.jpg&quot;)");
    expect(html).toContain("background-color:#f9eee0");
    expect(html).not.toContain("<img");

    const bare = renderToStaticMarkup(
      <PresetSwatch
        name="Parkes"
        image={null}
        fallback="#15101b"
        selected={false}
        onSelect={noop}
      />,
    );
    expect(bare).toContain('class="bg-preset-swatch" title="Parkes"');
    expect(bare).toContain('aria-pressed="false"');
    expect(bare).not.toContain("background-image");
    expect(bare).toContain("background-color:#15101b");
  });
});

describe("OptionsSheet", () => {
  const sheet = (open: boolean, chips: string[] = ["#111111", "#222222", "#333333", "#444444"]) =>
    renderToStaticMarkup(
      <OptionsSheet open={open} onToggle={noop} peek="Colour · Speed 1.00" chips={chips}>
        <span>body</span>
      </OptionsSheet>,
    );

  it("collapses to a summary bar that controls an inert body", () => {
    const html = sheet(false);
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1];

    expect(html).toMatch(/^<div class="bg-options-sheet">/);
    expect(html).toContain('class="bg-options-sheet-bar" aria-expanded="false"');
    expect(controls).toBeTruthy();
    expect(html).toContain(`<div id="${controls}" class="bg-options-sheet-body" inert="">`);
    expect(html).toContain('class="bg-options-sheet-title">Options</span>');
    expect(html).toContain('class="bg-options-sheet-peek">Colour · Speed 1.00</span>');
    expect(html).toContain('class="bg-options-sheet-chevron"');
  });

  it("shows at most three colour chips and drops the strip when there are none", () => {
    const html = sheet(false);
    expect(html.match(/class="bg-options-sheet-chip"/g)).toHaveLength(3);
    expect(html).toContain('class="bg-options-sheet-chips" aria-hidden="true"');
    expect(html).toContain("background:#333333");
    expect(html).not.toContain("#444444");
    expect(sheet(false, [])).not.toContain("bg-options-sheet-chips");
  });

  it("opens with the body reachable", () => {
    const html = sheet(true);
    expect(html).toMatch(/^<div class="bg-options-sheet open">/);
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain("inert");
  });
});

describe("sheet rows", () => {
  it("adds the trailing column only when a trailing control is given", () => {
    const plain = renderToStaticMarkup(
      <SheetRow label="Backing">
        <span>seg</span>
      </SheetRow>,
    );
    expect(plain).toBe(
      '<div class="bg-sheet-row"><span class="bg-sheet-label">Backing</span><span>seg</span></div>',
    );

    const trailing = renderToStaticMarkup(
      <SheetRow label="Backing" trailing={<button type="button">swatch</button>}>
        <span>seg</span>
      </SheetRow>,
    );
    expect(trailing).toContain('class="bg-sheet-row has-trailing"');
    expect(trailing).toMatch(/<span>seg<\/span><button type="button">swatch<\/button><\/div>$/);
  });

  it("lays each colour slot out as its picker followed by its name", () => {
    const html = renderToStaticMarkup(
      <SheetColours
        slots={[
          { key: "a", label: "Dust", picker: <button type="button">a</button> },
          { key: "b", label: "Sparkle", picker: <button type="button">b</button> },
        ]}
      />,
    );

    expect(html).toMatch(
      /^<div class="bg-sheet-colours"><span class="bg-sheet-label">Colours<\/span>/,
    );
    expect(html).toContain(
      '<span class="bg-sheet-colour"><button type="button">a</button><span class="bg-sheet-colour-label">Dust</span></span>',
    );
    expect(html.match(/class="bg-sheet-colour"/g)).toHaveLength(2);
  });

  it("renders a slider row at the step's precision with its fill seeded from the value", () => {
    const html = renderToStaticMarkup(
      <SheetSlider label="Count" value={900} min={200} max={1500} step={10} onCommit={noop} />,
    );

    expect(html).toContain('class="bg-sheet-slider" style="--bg-sheet-fill:0.5384615384615384"');
    expect(html).toContain('<span class="bg-sheet-label">Count</span>');
    expect(html).toContain('class="bg-sheet-slider-rail" aria-hidden="true"');
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-label="Count"');
    expect(html).toMatch(/class="range-value"[^>]*>900<\/button>/);

    const named = renderToStaticMarkup(
      <SheetSlider
        label="Size"
        ariaLabel="Point size"
        value={0.09}
        min={0.02}
        max={0.15}
        step={0.005}
        onCommit={noop}
      />,
    );
    expect(named).toContain('aria-label="Point size"');
    expect(named).toMatch(/class="range-value"[^>]*>0\.090<\/button>/);
  });

  it("clamps the fill to the track", () => {
    const over = renderToStaticMarkup(
      <SheetSlider label="Speed" value={9} min={0} max={3} step={0.05} onCommit={noop} />,
    );
    expect(over).toContain("--bg-sheet-fill:1");
    const flat = renderToStaticMarkup(
      <SheetSlider label="Speed" value={1} min={1} max={1} step={0.05} onCommit={noop} />,
    );
    expect(flat).toContain("--bg-sheet-fill:0");
  });

  it("separates sheet sections with a rule", () => {
    expect(renderToStaticMarkup(<SheetDivider />)).toBe('<hr class="bg-sheet-divider"/>');
  });
});

describe("stepDecimals", () => {
  it("spells a value at the precision its slider step implies", () => {
    expect(stepDecimals(1)).toBe(0);
    expect(stepDecimals(10)).toBe(0);
    expect(stepDecimals(0.5)).toBe(1);
    expect(stepDecimals(0.1)).toBe(1);
    expect(stepDecimals(0.05)).toBe(2);
    expect(stepDecimals(0.25)).toBe(2);
    expect(stepDecimals(0.01)).toBe(2);
    expect(stepDecimals(0.005)).toBe(3);
    expect(stepDecimals(0.1 + 0.2)).toBe(1);
  });

  it("falls back to whole numbers for degenerate steps and caps tiny ones", () => {
    expect(stepDecimals(0)).toBe(0);
    expect(stepDecimals(Number.NaN)).toBe(0);
    expect(stepDecimals(-0.05)).toBe(2);
    expect(stepDecimals(1e-9)).toBe(6);
  });
});

describe("sheetPeek", () => {
  it("summarises backing, speed, the first param and staging", () => {
    expect(
      sheetPeek({
        backing: "Colour",
        speed: 1,
        param: { label: "Count", value: 900, step: 10 },
        staging: false,
      }),
    ).toBe("Colour · Speed 1.00 · Count 900 · Staging off");
  });

  it("places Zoom before the first param and spells the param at its step", () => {
    expect(
      sheetPeek({
        speed: 0.5,
        zoom: 1.25,
        param: { label: "Twinkle", value: 0.6, step: 0.01 },
        staging: true,
      }),
    ).toBe("Speed 0.50 · Zoom 1.25 · Twinkle 0.60 · Staging on");
  });

  it("drops every absent part, including staging when there is no stage", () => {
    expect(sheetPeek({ speed: 2, staging: null })).toBe("Speed 2.00");
    expect(sheetPeek({ backing: "Gradient", speed: 1, staging: null })).toBe(
      "Gradient · Speed 1.00",
    );
  });
});
