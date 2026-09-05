import { gradientCss } from "../../theme/gradientPresets";
import type { Theme } from "../../theme/tokens";
import { ThemeEditorIcon } from "./icons";
import { SpecimenCanvas } from "./SpecimenCanvas";

/** The specimen column: the live canvas on top (real scenes under the draft theme), then the flat facts a rendered frame cannot spell out, the token hexes and the gradient library. */
export function SpecimenPanel({ theme }: { theme: Theme }) {
  const { colors, motion } = theme;
  const chartColours = theme.chartColors ?? [colors.accent];
  const gradients = Object.entries(theme.gradients ?? {});

  return (
    <aside className="theme-editor-specimen" aria-label="Theme specimen">
      <header className="theme-editor-specimen-head">
        <ThemeEditorIcon name="specimen" size={15} />
        <span>Specimen</span>
      </header>

      <SpecimenCanvas theme={theme} />

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
