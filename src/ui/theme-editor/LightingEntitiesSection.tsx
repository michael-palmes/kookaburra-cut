import { useState } from "react";
import type { FixtureSpec, LightSpec, Theme } from "../../theme/tokens";
import {
  FIXTURE_DEFAULTS,
  FixtureEditor,
  FORM_LABEL,
  LIGHT_DEFAULTS,
  LightEditor,
  TYPE_LABEL,
} from "../inspector/LightingSection";
import { Field, IconButton, IconSelect } from "./fields";
import { ThemeEditorIcon, type ThemeEditorIconName } from "./icons";
import type { ThemeDoc } from "./themeDraft";
import {
  appendThemeLightingEntity,
  changeThemeLightType,
  duplicateThemeLightingEntity,
  nextThemeLightingId,
  patchThemeLightingEntity,
  removeThemeLightingEntity,
} from "./themeLightingDraft";

const LIGHT_ICONS: Record<LightSpec["type"], ThemeEditorIconName> = {
  directional: "sun",
  point: "light",
  spot: "spot",
  area: "panel",
};

export function LightingEntitiesSection({
  doc,
  theme,
  onPatch,
}: {
  doc: ThemeDoc;
  theme: Theme;
  onPatch: (next: ThemeDoc) => void;
}) {
  const [fixtureForm, setFixtureForm] = useState<FixtureSpec["form"]>("tube");
  const lights = theme.lighting?.lights ?? [];
  const fixtures = theme.lighting?.fixtures ?? [];
  return (
    <>
      <Field
        label="Free lights"
        icon="light"
        hint="Choose a light to edit its placement, aim, colour and falloff."
      >
        <div className="theme-editor-light-list">
          {lights.map((light) => {
            const patch = (mutate: (next: LightSpec) => void) =>
              onPatch(patchThemeLightingEntity(doc, "lights", light, mutate));
            return (
              <details key={light.id} className="theme-editor-light">
                <summary>
                  <ThemeEditorIcon name={LIGHT_ICONS[light.type]} size={14} />{" "}
                  {light.name ?? TYPE_LABEL[light.type]}
                </summary>
                <IconSelect
                  icon={LIGHT_ICONS[light.type]}
                  label={`${light.id} type`}
                  value={light.type}
                  options={Object.entries(TYPE_LABEL).map(([id, label]) => ({ id, label }))}
                  onChange={(type) =>
                    patch((next) => changeThemeLightType(next, type as LightSpec["type"]))
                  }
                />
                <LightEditor
                  embedded
                  light={light}
                  colors={theme.colors}
                  onBack={() => {}}
                  onLive={patch}
                  onCommit={patch}
                  onDuplicate={() => onPatch(duplicateThemeLightingEntity(doc, "lights", light.id))}
                  onDelete={() => onPatch(removeThemeLightingEntity(doc, "lights", light.id))}
                />
              </details>
            );
          })}
          <IconButton
            icon="add"
            label="Add light"
            onClick={() =>
              onPatch(
                appendThemeLightingEntity(
                  doc,
                  "lights",
                  LIGHT_DEFAULTS.directional(nextThemeLightingId(doc, "lights")),
                ),
              )
            }
          />
        </div>
      </Field>
      <Field
        label="Fixtures"
        icon="panel"
        hint="Emissive shapes with optional paired lights. Bloom makes them glow."
      >
        <div className="theme-editor-light-list">
          {fixtures.map((fixture) => {
            const patch = (mutate: (next: FixtureSpec) => void) =>
              onPatch(patchThemeLightingEntity(doc, "fixtures", fixture, mutate));
            return (
              <details key={fixture.id} className="theme-editor-light">
                <summary>
                  <ThemeEditorIcon name="panel" size={14} />{" "}
                  {fixture.name ?? FORM_LABEL[fixture.form]}
                </summary>
                <FixtureEditor
                  embedded
                  fixture={fixture}
                  colors={theme.colors}
                  onBack={() => {}}
                  onLive={patch}
                  onCommit={patch}
                  onDuplicate={() =>
                    onPatch(duplicateThemeLightingEntity(doc, "fixtures", fixture.id))
                  }
                  onDelete={() => onPatch(removeThemeLightingEntity(doc, "fixtures", fixture.id))}
                />
              </details>
            );
          })}
          <div className="theme-editor-inline">
            <IconSelect
              icon="panel"
              label="New fixture shape"
              value={fixtureForm}
              options={Object.entries(FORM_LABEL).map(([id, label]) => ({ id, label }))}
              onChange={(form) => setFixtureForm(form as FixtureSpec["form"])}
            />
            <IconButton
              icon="add"
              label="Add fixture"
              onClick={() =>
                onPatch(
                  appendThemeLightingEntity(
                    doc,
                    "fixtures",
                    FIXTURE_DEFAULTS[fixtureForm](nextThemeLightingId(doc, "fixtures")),
                  ),
                )
              }
            />
          </div>
        </div>
      </Field>
    </>
  );
}
