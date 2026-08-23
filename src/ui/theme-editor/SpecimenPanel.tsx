import { gradientCss } from "../../theme/gradientPresets";
import type { Theme } from "../../theme/tokens";
import { ThemeEditorIcon } from "./icons";

/** The live specimen, plain DOM for this wave: the four colour tokens, the chart palette, the two faces at three ramp steps, and the gradients, all painted from the DRAFT rather than from disk. The r3f specimen canvas (the preview-lab scenes under the draft theme) replaces the body of this panel next wave; the export path never touches either. */
export function SpecimenPanel({ theme }: { theme: Theme }) {
  const { colors, typography, motion } = theme;
  const chartColours = theme.chartColors ?? [colors.accent];
  const gradients = Object.entries(theme.gradients ?? {});
  const step = (power: number) => `${Math.round(16 * typography.scale ** power)}px`;

  return (
    <aside className="theme-editor-specimen" aria-label="Theme specimen">
      <header className="theme-editor-specimen-head">
        <ThemeEditorIcon name="specimen" size={15} />
        <span>Specimen</span>
      </header>

      <div className="theme-editor-specimen-canvas" style={{ background: colors.background }}>
        <p
          style={{
            color: colors.text,
            fontFamily: `"${typography.headline.family}", var(--font-ui)`,
            fontWeight: typography.headline.weight,
            fontSize: step(2),
            lineHeight: 1.1,
          }}
        >
          The quick brown fox
        </p>
        <p
          style={{
            color: colors.text,
            fontFamily: `"${typography.headline.family}", var(--font-ui)`,
            fontWeight: typography.headline.weight,
            fontSize: step(1),
            lineHeight: 1.15,
          }}
        >
          Jumps over the lazy dog
        </p>
        <p
          style={{
            color: colors.muted,
            fontFamily: `"${typography.body.family}", var(--font-ui)`,
            fontWeight: typography.body.weight,
            fontSize: step(0),
            lineHeight: 1.45,
          }}
        >
          Body copy at the base step, in the muted token. Numerals 0123456789.
        </p>
        <span
          className="theme-editor-specimen-pill"
          style={{ background: colors.accent, color: colors.background }}
        >
          Accent
        </span>
      </div>

      <section className="theme-editor-specimen-group">
        <h3>Tokens</h3>
        <div className="theme-editor-specimen-swatches">
          {(["background", "text", "accent", "muted"] as const).map((slot) => (
            <span key={slot} className="theme-editor-specimen-swatch">
              <i style={{ background: colors[slot] }} />
              <b>{slot}</b>
              <code>{colors[slot]}</code>
            </span>
          ))}
        </div>
      </section>

      <section className="theme-editor-specimen-group">
        <h3>Chart palette</h3>
        <div className="theme-editor-specimen-bars">
          {chartColours.map((colour, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: position IS the series identity
              key={index}
              style={{
                background: colour,
                height: `${30 + ((index * 17) % 55)}%`,
              }}
              title={colour}
            />
          ))}
        </div>
      </section>

      {gradients.length > 0 && (
        <section className="theme-editor-specimen-group">
          <h3>Gradients</h3>
          <div className="theme-editor-specimen-gradients">
            {gradients.map(([name, spec]) => (
              <span key={name} className="theme-editor-specimen-gradient">
                <i style={{ background: gradientCss(spec) }} />
                <b>{name}</b>
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="theme-editor-specimen-group">
        <h3>Motion</h3>
        <dl className="theme-editor-specimen-facts">
          <div>
            <dt>Durations</dt>
            <dd>
              {motion.durations.fast} · {motion.durations.base} · {motion.durations.slow} ms
            </dd>
          </div>
          <div>
            <dt>Easings</dt>
            <dd>
              {motion.easings.standard} · {motion.easings.emphasized}
            </dd>
          </div>
          <div>
            <dt>Text</dt>
            <dd>
              {theme.textAnimation
                ? `${theme.textAnimation.in} → ${theme.textAnimation.out}`
                : "engine default"}
            </dd>
          </div>
        </dl>
      </section>
    </aside>
  );
}
