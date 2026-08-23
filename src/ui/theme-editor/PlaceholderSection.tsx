import { Section } from "./fields";
import { ThemeEditorIcon, type ThemeEditorIconName } from "./icons";
import { isRecord, type ThemeDoc } from "./themeDraft";

/** Stage, Lighting and Effects land next wave. Until then the section still earns its place: it says which blocks the document already carries, so nobody mistakes an unbuilt form for a missing block and hand-edits the JSON on top of a live draft. */
export function PlaceholderSection({
  title,
  hint,
  icon,
  doc,
  blocks,
}: {
  title: string;
  hint: string;
  icon: ThemeEditorIconName;
  doc: ThemeDoc;
  /** The document keys this section will own. */
  blocks: readonly { key: string; label: string }[];
}) {
  return (
    <Section title={title} hint={hint}>
      <div className="theme-editor-placeholder">
        <ThemeEditorIcon name={icon} size={28} />
        <p>This section arrives next wave. Saving never touches the blocks it will own.</p>
        <ul className="theme-editor-block-list">
          {blocks.map(({ key, label }) => {
            const value = doc[key];
            const present = value !== undefined;
            return (
              <li key={key}>
                <ThemeEditorIcon name={present ? "visible" : "hidden"} size={14} />
                <span>{label}</span>
                <code>{describeBlock(value)}</code>
              </li>
            );
          })}
        </ul>
      </div>
    </Section>
  );
}

function describeBlock(value: unknown): string {
  if (value === undefined) return "not set";
  if (isRecord(value)) {
    const keys = Object.keys(value);
    return keys.length === 0 ? "empty" : keys.join(", ");
  }
  if (Array.isArray(value)) return `${value.length} entries`;
  return String(value);
}
