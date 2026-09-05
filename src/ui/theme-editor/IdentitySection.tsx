import { useState } from "react";
import { THEME_CATEGORIES, type ThemeCategoryId } from "../../theme/catalogue";
import {
  Field,
  IconOptions,
  IconSelect,
  IconToggle,
  NumberField,
  Section,
  TextField,
} from "./fields";
import { ThemeEditorIcon } from "./icons";
import { addTag, readIdentity, removeTag, type ThemeDoc, writeIdentity } from "./themeDraft";

/** Identity: everything the theme browser reads off a card. Name and mode live at the document root, the rest in the `catalogue` block, which the schema only accepts whole, so `writeIdentity` rewrites it from the resolved values. */
export function IdentitySection({
  doc,
  onPatch,
  devTools,
}: {
  doc: ThemeDoc;
  onPatch: (next: ThemeDoc) => void;
  /** Bundled themes in a checkout: the hidden flag only means anything there. */
  devTools: boolean;
}) {
  const identity = readIdentity(doc);
  const [tagDraft, setTagDraft] = useState("");
  const patch = (next: Parameters<typeof writeIdentity>[1]) => onPatch(writeIdentity(doc, next));

  return (
    <Section
      title="Identity"
      hint="How this theme shows up in the browser: its name, its collection, and the words that find it."
    >
      <Field label="Name" icon="identity">
        <TextField
          label="Theme name"
          value={identity.name}
          placeholder="Untitled theme"
          onCommit={(name) => patch({ name })}
        />
      </Field>

      <Field label="Mode" icon="light" hint="Drives the light/dark filter and the card's mode pip.">
        <IconOptions
          label="Theme mode"
          value={identity.mode}
          onChange={(mode) => patch({ mode })}
          options={[
            { id: "dark", label: "Dark", icon: "dark" },
            { id: "light", label: "Light", icon: "light" },
          ]}
        />
      </Field>

      <Field label="Collection" icon="category">
        <IconSelect
          icon="category"
          label="Theme collection"
          value={identity.category}
          onChange={(category) => patch({ category: category as ThemeCategoryId })}
          options={THEME_CATEGORIES.map(({ id, label }) => ({ id, label }))}
        />
      </Field>

      <Field label="Use label" icon="label" hint="The one-line description under the card's name.">
        <TextField
          label="Use label"
          value={identity.useLabel}
          placeholder="Custom workspace theme"
          onCommit={(useLabel) => patch({ useLabel })}
        />
      </Field>

      <Field
        label="Tags"
        icon="tag"
        hint="Extra search terms; Enter adds one, click a tag to drop it."
      >
        <div className="theme-editor-tags">
          {identity.tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className="chip chip-with-icon selected"
              title={`Remove "${tag}"`}
              onClick={() => patch({ tags: removeTag(identity.tags, tag) })}
            >
              <ThemeEditorIcon name="remove" size={14} />
              {tag}
            </button>
          ))}
          <input
            type="text"
            className="modal-input theme-editor-tag-input"
            value={tagDraft}
            placeholder="Add a tag"
            aria-label="Add a tag"
            onChange={(event) => setTagDraft(event.target.value)}
            onBlur={() => {
              if (tagDraft.trim() === "") return;
              patch({ tags: addTag(identity.tags, tagDraft) });
              setTagDraft("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                (event.target as HTMLInputElement).blur();
              }
              if (event.key === "Escape") setTagDraft("");
            }}
          />
        </div>
      </Field>

      <Field
        label="Order"
        icon="order"
        hint="Sort key within the collection, lower first. Empty sorts alphabetically."
      >
        <NumberField
          label="Catalogue order"
          value={identity.order}
          min={0}
          step={10}
          allowEmpty
          onCommit={(order) => patch({ order })}
        />
      </Field>

      {devTools && (
        <Field label="Hidden" icon="hidden" hint="Dev only: keeps the theme out of the browser.">
          <IconToggle
            icon="hidden"
            offIcon="visible"
            label={identity.hidden ? "Hidden" : "Listed"}
            checked={identity.hidden}
            onChange={(hidden) => patch({ hidden })}
          />
        </Field>
      )}
    </Section>
  );
}
