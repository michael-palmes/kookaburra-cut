/** Threshold line art for the first-run surfaces: the Home start cards and the wizard's Create with Claude card. Paint comes from classes in styles.css, so the drawings follow the chrome tokens (and the Claude card's own scoped palette). */

export function NewProjectArt() {
  return (
    <svg className="start-art" viewBox="0 0 360 202" aria-hidden="true">
      <rect x="154" y="45" width="128" height="72" rx="6" className="art-panel art-line" />
      <rect x="138" y="59" width="128" height="72" rx="6" className="art-raised art-line" />
      <rect
        x="122"
        y="73"
        width="128"
        height="72"
        rx="6"
        className="art-elevated art-line-accent"
      />
      <rect x="138" y="95" width="68" height="9" rx="4.5" className="art-text" />
      <rect x="138" y="111" width="44" height="6" rx="3" className="art-faint" />
      <circle cx="250" cy="147" r="20" className="art-accent" />
      <path d="M250 137v20M240 147h20" className="art-line-on-accent" />
    </svg>
  );
}

export function ImportPackArt() {
  return (
    <svg className="start-art" viewBox="0 0 360 202" aria-hidden="true">
      <path d="M180 81 228 103 180 125 132 103z" className="art-raised art-line-faint" />
      <path d="M132 103 180 125 180 171 132 149z" className="art-panel art-line-faint" />
      <path d="M228 103 180 125 180 171 228 149z" className="art-elevated art-line-faint" />
      <path d="M180 33v62M166 81l14 14 14-14" className="art-line-accent-text" />
    </svg>
  );
}

/** An eight-ray spark in Claude's clay, drawn here rather than the trademarked mark. */
export function ClaudeSpark() {
  return (
    <svg className="claude-spark" viewBox="-12 -12 24 24" aria-hidden="true">
      <path d="M0-10V-3M0 3V10M-10 0H-3M3 0H10M-7-7L-2.2-2.2M2.2 2.2L7 7M-7 7L-2.2 2.2M2.2-2.2L7-7" />
    </svg>
  );
}

/** A small Claude Desktop composer: the greeting, a typed prompt and the send button. */
export function ClaudeComposerArt() {
  return (
    <svg
      className="start-art claude-art"
      viewBox="0 0 760 200"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <rect width="760" height="200" className="c-ground" />
      <path
        transform="translate(266 47)"
        d="M0-11V-3M0 3V11M-11 0H-3M3 0H11M-7.8-7.8L-2.2-2.2M2.2 2.2L7.8 7.8M-7.8 7.8L-2.2 2.2M2.2-2.2L7.8-7.8"
        className="c-spark"
      />
      <text x="286" y="56" className="c-greeting">
        What are we making?
      </text>
      <rect x="160" y="76" width="440" height="100" rx="18" className="c-field" />
      <text x="182" y="106" className="c-prompt">
        A 20 second launch video for our new app
      </text>
      <rect x="486" y="93" width="2" height="17" className="c-caret" />
      <rect x="180" y="138" width="26" height="26" rx="8" className="c-tool" />
      <path d="M193 145v12M187 151h12" className="c-tool-glyph" />
      <text x="496" y="156" className="c-model">
        Claude
      </text>
      <path d="M538 149l3 3 3-3" className="c-model-glyph" />
      <rect x="558" y="138" width="26" height="26" rx="8" className="c-send" />
      <path d="M571 157v-11M566 151l5-5 5 5" className="c-send-glyph" />
    </svg>
  );
}
