import type { Theme } from "../../theme/tokens";
import { TextLookPanel } from "../TextLookPicker";
import { Section } from "./fields";
import { type ThemeDoc, writeThemeTextLook } from "./themeDraft";

export function TextLookSection({
  doc,
  theme,
  onPatch,
}: {
  doc: ThemeDoc;
  theme: Theme;
  onPatch: (next: ThemeDoc) => void;
}) {
  return (
    <Section
      title="Text style"
      hint="The default appearance of text. Scenes and individual lines can choose their own style."
    >
      <TextLookPanel
        current={theme.textLook}
        mode="theme"
        theme={theme}
        codedLook={false}
        force={false}
        onForce={() => {}}
        onLive={(spec) => onPatch(writeThemeTextLook(doc, spec))}
      />
    </Section>
  );
}
