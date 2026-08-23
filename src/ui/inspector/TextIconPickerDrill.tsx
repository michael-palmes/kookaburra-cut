import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { isAssetReference } from "../../toolkit/frame/icon";
import { MediaBrowser } from "../MediaBrowser";
import { DrillBack } from "./rows";
import { TEXT_ICON_EMOJIS } from "./textIconEmojiCatalogue";

export function textIconPickerMountKey(
  projectId: string,
  sceneIdentity: string | number,
  route: string,
): string {
  return `${projectId}\u0000${sceneIdentity}\u0000${route}`;
}

export interface TextIconEmojiPickerDrillProps {
  initialValue?: string;
  backLabel?: string;
  notice?: string | null;
  disabled?: boolean;
  onBack: () => void;
  onPick: (value: string) => void;
  onError?: (message: string) => void;
}

export async function requestTextIconCharacterPalette(
  onError?: (message: string) => void,
): Promise<void> {
  try {
    await invoke("show_character_palette");
  } catch (error) {
    onError?.(String(error));
  }
}

export function textIconEmojiInitialValue(value: string | undefined): string {
  return value && !isAssetReference(value) ? value : "";
}

export function TextIconEmojiPickerDrill({
  initialValue = "",
  backLabel = "Text",
  notice,
  disabled = false,
  onBack,
  onPick,
  onError,
}: TextIconEmojiPickerDrillProps) {
  const [draft, setDraft] = useState(() => textIconEmojiInitialValue(initialValue));
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() =>
      inputRef.current?.focus({ preventScroll: true }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const commit = (value: string) => {
    const picked = value.trim();
    if (picked) onPick(picked);
  };

  return (
    <div className="inspector-drill">
      <DrillBack label={backLabel} title="Choose emoji" onClick={onBack} />
      <div className="inspector-drill-body">
        {notice && (
          <p className="inspector-error" role="alert">
            {notice}
          </p>
        )}
        <label className="wizard-field">
          <span className="wizard-label">Emoji or symbol</span>
          <input
            ref={inputRef}
            className="modal-input"
            value={draft}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              commit(draft);
            }}
          />
        </label>
        <fieldset className="chip-icon-grid text-emoji-grid" disabled={disabled}>
          <legend className="visually-hidden">Emoji catalogue</legend>
          {TEXT_ICON_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              title={emoji}
              aria-label={`Use ${emoji}`}
              aria-pressed={draft === emoji}
              className={`chip-icon-tile emoji${draft === emoji ? " selected" : ""}`}
              onClick={() => onPick(emoji)}
            >
              {emoji}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="inspector-drill-actions">
        <button
          type="button"
          className="btn btn-left"
          disabled={disabled}
          onClick={() => {
            inputRef.current?.focus({ preventScroll: true });
            void requestTextIconCharacterPalette(onError);
          }}
        >
          More emoji…
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={disabled || !draft.trim()}
          onClick={() => commit(draft)}
        >
          Use icon
        </button>
      </div>
    </div>
  );
}

export interface TextIconImagePickerDrillProps {
  slug: string;
  projectPath: string;
  refreshKey?: number;
  selectedRel?: string | null;
  backLabel?: string;
  disabled?: boolean;
  onBack: () => void;
  onPick: (rel: string) => void;
}

export function TextIconImagePickerDrill({
  slug,
  projectPath,
  refreshKey,
  selectedRel,
  backLabel = "Text",
  disabled = false,
  onBack,
  onPick,
}: TextIconImagePickerDrillProps) {
  return (
    <div className="inspector-drill">
      <DrillBack label={backLabel} title="Choose image" onClick={onBack} />
      <div className="inspector-drill-body" aria-busy={disabled || undefined}>
        <div className="inspector-media-host">
          <fieldset disabled={disabled} className="text-icon-image-picker-fieldset">
            <MediaBrowser
              inspectorPreview
              slug={slug}
              projectPath={projectPath}
              refreshKey={refreshKey}
              kinds={["image"]}
              globalToggle
              selectedRel={selectedRel}
              onPick={(rel) => onPick(rel)}
            />
          </fieldset>
        </div>
      </div>
    </div>
  );
}
