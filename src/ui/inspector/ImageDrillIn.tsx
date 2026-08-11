import { type ReactNode, type Ref, useCallback, useEffect, useId, useRef, useState } from "react";
import { useImageEditStore } from "../../engine/imageEditStore";
import type { SceneDoc, SceneDocImageSpec, SceneImageHost } from "../../engine/sceneDocSchema";
import { duplicateImage, removeImage } from "./imageEditorModel";
import {
  ActionRow,
  DrillBack,
  DrillGroup,
  GizmoModeIcon,
  InspectorSliderRow,
  NumberField,
  type SegmentedOption,
  SegmentedRow,
  ToggleRow,
} from "./rows";

export type ImageDocPatch = (next: SceneDoc) => void;
export type ImagePatchDoc = (
  patch: ImageDocPatch,
  opts?: { history?: string | false },
) => Promise<void>;

export interface ImageDrillInProps {
  doc: SceneDoc;
  imageId: string;
  sourcePreviewUrl?: string;
  overlayAvailable: boolean;
  sourceButtonRef?: Ref<HTMLButtonElement>;
  sourceDisabled?: boolean;
  settingsDisabled?: boolean;
  duplicateDisabled?: boolean;
  removeDisabled?: boolean;
  backLabel?: string;
  onBack: () => void;
  onSelectImage: (imageId: string) => void;
  onChangeSource: (imageId: string) => void;
  onImageRemoved?: () => void;
  /** Override every entity write, for example to atomically promote a virtual legacy image. */
  mutateImage?: (mutate: ImageMutation, opts: ImageMutationOptions) => Promise<void>;
  /** Override the first-class duplicate path when the displayed image is virtual. */
  onDuplicate?: () => void;
  /** Override the first-class remove path when the displayed image is virtual. */
  onRemove?: () => void;
  patchDoc: ImagePatchDoc;
  commitFromBaseline: (baseline: SceneDoc, patch: ImageDocPatch) => Promise<void>;
  notice?: ReactNode;
  motionContent?: ReactNode;
}

export type ImageMutation = (image: SceneDocImageSpec) => void;

export interface ImageMutationOptions {
  history: string | false;
  baseline?: SceneDoc;
}

const GIZMO_OPTIONS: SegmentedOption<"translate" | "rotate" | "scale">[] = [
  { value: "translate", label: "Move", icon: <GizmoModeIcon mode="translate" /> },
  { value: "rotate", label: "Rotate", icon: <GizmoModeIcon mode="rotate" /> },
  { value: "scale", label: "Scale", icon: <GizmoModeIcon mode="scale" /> },
];

const REMOVE_CONFIRMATION_MS = 3_000;

export function armImageRemoveConfirmation(onDisarm: () => void): () => void {
  const timeout = setTimeout(onDisarm, REMOVE_CONFIRMATION_MS);
  return () => clearTimeout(timeout);
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

function ImageControlIcon({ type }: { type: "x" | "y" | "depth" | "size" | "roll" }) {
  const glyph = {
    x: <path d="M2.6 8h10.8M4.8 5.8 2.6 8l2.2 2.2M11.2 5.8 13.4 8l-2.2 2.2" />,
    y: <path d="M8 2.6v10.8M5.8 4.8 8 2.6l2.2 2.2M5.8 11.2 8 13.4l2.2-2.2" />,
    depth: (
      <>
        <rect x="8.2" y="2.4" width="5.4" height="5.4" rx="1" />
        <rect x="2.4" y="8.2" width="5.4" height="5.4" rx="1" />
        <path d="M8.2 7.8 7.8 8.2" />
      </>
    ),
    size: <path d="M3 9.6V13h3.4M13 6.4V3H9.6M3.2 12.8 7.4 8.6M12.8 3.2 8.6 7.4" />,
    roll: (
      <>
        <path d="M13.4 8A5.4 5.4 0 114.9 3.6" />
        <path d="M4.2 1.8v3.6h3.6" />
      </>
    ),
  }[type];
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}

function NavigationIcon({ direction }: { direction: "previous" | "next" }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={direction === "previous" ? "M10 3L5 8l5 5" : "M6 3l5 5-5 5"} />
    </svg>
  );
}

function FooterIcon({ type }: { type: "duplicate" | "remove" }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {type === "duplicate" ? (
        <>
          <rect x="5" y="5" width="8" height="8" rx="1.5" />
          <path d="M3 10H2.5A1.5 1.5 0 011 8.5v-6A1.5 1.5 0 012.5 1h6A1.5 1.5 0 0110 2.5V3" />
        </>
      ) : (
        <>
          <path d="M3 4h10M6 4V2.5h4V4M5 6.5v5M8 6.5v5M11 6.5v5" />
          <path d="M4 4l.6 9h6.8l.6-9" />
        </>
      )}
    </svg>
  );
}

function imageFileName(src: string): string {
  return src.split("/").filter(Boolean).at(-1) ?? src;
}

function mutateDocImage(next: SceneDoc, imageId: string, mutate: ImageMutation) {
  const image = next.images?.find((candidate) => candidate.id === imageId);
  if (image) mutate(image);
}

export { duplicateImage, removeImage } from "./imageEditorModel";

export async function duplicateFirstClassImage(
  patchDoc: ImagePatchDoc,
  imageId: string,
  onSelectImage: (imageId: string) => void,
): Promise<void> {
  let duplicateId: string | null = null;
  await patchDoc(
    (next) => {
      duplicateId = duplicateImage(next, imageId);
    },
    { history: "duplicate image" },
  );
  if (duplicateId) onSelectImage(duplicateId);
}

export async function removeFirstClassImage(
  patchDoc: ImagePatchDoc,
  imageId: string,
  onImageRemoved?: () => void,
): Promise<void> {
  await patchDoc((next) => removeImage(next, imageId), { history: "remove image" });
  onImageRemoved?.();
}

export function ImageDrillIn({
  doc,
  imageId,
  sourcePreviewUrl,
  overlayAvailable,
  sourceButtonRef,
  sourceDisabled = false,
  settingsDisabled = false,
  duplicateDisabled = false,
  removeDisabled = false,
  backLabel = "Scene",
  onBack,
  onSelectImage,
  onChangeSource,
  onImageRemoved,
  mutateImage,
  onDuplicate,
  onRemove,
  patchDoc,
  commitFromBaseline,
  notice,
  motionContent,
}: ImageDrillInProps) {
  const overlayReasonId = `image-overlay-${useId().replaceAll(":", "")}`;
  const dragBaseline = useRef<SceneDoc | null>(null);
  const pendingGesture = useRef<(() => void) | null>(null);
  const [removeConfirmImageId, setRemoveConfirmImageId] = useState<string | null>(null);
  const gizmoMode = useImageEditStore((state) => state.gizmoMode);
  const images = doc.images ?? [];
  const imageIndex = images.findIndex((candidate) => candidate.id === imageId);
  const image = images[imageIndex];
  const sourceActionRef = useCallback(
    (node: HTMLDivElement | null) => {
      assignRef(sourceButtonRef, node?.querySelector<HTMLButtonElement>(".action-row") ?? null);
    },
    [sourceButtonRef],
  );

  useEffect(
    () => () => {
      const flush = pendingGesture.current;
      pendingGesture.current = null;
      dragBaseline.current = null;
      flush?.();
    },
    [],
  );

  useEffect(() => {
    if (removeConfirmImageId == null) return;
    return armImageRemoveConfirmation(() => setRemoveConfirmImageId(null));
  }, [removeConfirmImageId]);

  if (!image) {
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} title="Image" onClick={onBack} />
        <div className="inspector-drill-body">
          <p className="modal-hint">This image is no longer in the scene.</p>
        </div>
      </div>
    );
  }

  const patchImage = (mutate: ImageMutation, history: string, preview = false) => {
    if (settingsDisabled) return;
    if (preview) {
      if (!dragBaseline.current) dragBaseline.current = structuredClone(doc);
      const baseline = dragBaseline.current;
      if (mutateImage) {
        pendingGesture.current = () => {
          void mutateImage(mutate, { history, baseline });
        };
        void mutateImage(mutate, { history: false });
      } else {
        const patch = (next: SceneDoc) => mutateDocImage(next, image.id, mutate);
        pendingGesture.current = () => {
          void commitFromBaseline(baseline, patch);
        };
        void patchDoc(patch, { history: false });
      }
      return;
    }

    const baseline = dragBaseline.current;
    pendingGesture.current = null;
    dragBaseline.current = null;
    if (mutateImage) {
      void mutateImage(mutate, baseline ? { history, baseline } : { history });
      return;
    }
    const patch = (next: SceneDoc) => mutateDocImage(next, image.id, mutate);
    if (baseline) void commitFromBaseline(baseline, patch);
    else void patchDoc(patch, { history });
  };
  const chooseHost = (host: SceneImageHost) => {
    if (host === image.host || (host === "overlay" && !overlayAvailable)) return;
    patchImage((candidate) => (candidate.host = host), `move image to ${host}`);
  };
  const duplicate = () => {
    if (duplicateDisabled) return;
    if (onDuplicate) {
      onDuplicate();
      return;
    }
    void duplicateFirstClassImage(patchDoc, image.id, onSelectImage);
  };
  const remove = () => {
    if (removeDisabled) return;
    if (removeConfirmImageId !== image.id) {
      setRemoveConfirmImageId(image.id);
      return;
    }
    setRemoveConfirmImageId(null);
    if (onRemove) {
      onRemove();
      return;
    }
    void removeFirstClassImage(patchDoc, image.id, onImageRemoved);
  };

  const stage = image.stage;
  const overlay = image.overlay;
  const fileName = imageFileName(image.src);

  return (
    <div className="inspector-drill image-drill">
      <DrillBack label={backLabel} title="Image" onClick={onBack} />
      <div className="inspector-scene-head image-drill-identity">
        <div className="inspector-scene-preview">
          {sourcePreviewUrl && <img src={sourcePreviewUrl} alt="" draggable={false} />}
        </div>
        <div className="inspector-scene-id">
          <div className="inspector-scene-title" title={fileName}>
            {fileName}
          </div>
          <div className="inspector-scene-sub">
            Image {imageIndex + 1} of {images.length}
          </div>
        </div>
        <div className="wizard-presets">
          <button
            type="button"
            className="chip"
            aria-label="Previous image"
            title="Previous image"
            disabled={imageIndex <= 0}
            onClick={() => onSelectImage(images[imageIndex - 1].id)}
          >
            <NavigationIcon direction="previous" />
          </button>
          <button
            type="button"
            className="chip"
            aria-label="Next image"
            title="Next image"
            disabled={imageIndex >= images.length - 1}
            onClick={() => onSelectImage(images[imageIndex + 1].id)}
          >
            <NavigationIcon direction="next" />
          </button>
        </div>
      </div>

      <div className="inspector-drill-body inspector-section-body image-drill-body">
        {notice != null && <div className="inspector-stub-note image-drill-notice">{notice}</div>}
        <DrillGroup label="Source">
          <div ref={sourceActionRef} data-image-source-action="true">
            <ActionRow
              label="Change source"
              value={fileName}
              disabled={sourceDisabled}
              onClick={() => onChangeSource(image.id)}
            />
          </div>
        </DrillGroup>

        <fieldset className="image-settings-fieldset" disabled={settingsDisabled}>
          <legend className="visually-hidden">Image settings</legend>
          <DrillGroup label="Host">
            <fieldset className="wizard-presets image-host-options">
              <legend className="visually-hidden">Image host</legend>
              <button
                type="button"
                className={`chip${image.host === "stage" ? " selected" : ""}`}
                aria-pressed={image.host === "stage"}
                onClick={() => chooseHost("stage")}
              >
                Stage
              </button>
              <button
                type="button"
                className={`chip${image.host === "overlay" ? " selected" : ""}`}
                aria-pressed={image.host === "overlay"}
                aria-disabled={!overlayAvailable}
                aria-describedby={overlayAvailable ? undefined : overlayReasonId}
                onClick={() => chooseHost("overlay")}
              >
                Overlay
              </button>
            </fieldset>
            {!overlayAvailable && (
              <span id={overlayReasonId} className="drill-group-hint">
                Add an Overlay to this scene before moving an image there.
              </span>
            )}
          </DrillGroup>

          {image.host === "stage" ? (
            <>
              <DrillGroup label="Transform">
                <SegmentedRow
                  options={GIZMO_OPTIONS}
                  value={gizmoMode}
                  onChange={(mode) => {
                    if (!settingsDisabled) useImageEditStore.getState().setGizmoMode(mode);
                  }}
                />
                {gizmoMode === "translate" && (
                  <>
                    <InspectorSliderRow
                      icon={<ImageControlIcon type="x" />}
                      label="X"
                      value={stage.position[0]}
                      min={-4}
                      max={4}
                      step={0.01}
                      onInput={(value) =>
                        patchImage(
                          (candidate) => {
                            candidate.stage.position = [
                              value,
                              candidate.stage.position[1],
                              candidate.stage.position[2],
                            ];
                          },
                          "image position",
                          true,
                        )
                      }
                      onCommit={(value) =>
                        patchImage((candidate) => {
                          candidate.stage.position = [
                            value,
                            candidate.stage.position[1],
                            candidate.stage.position[2],
                          ];
                        }, "image position")
                      }
                    />
                    <InspectorSliderRow
                      icon={<ImageControlIcon type="y" />}
                      label="Y"
                      value={stage.position[1]}
                      min={-3}
                      max={3}
                      step={0.01}
                      onInput={(value) =>
                        patchImage(
                          (candidate) => {
                            candidate.stage.position = [
                              candidate.stage.position[0],
                              value,
                              candidate.stage.position[2],
                            ];
                          },
                          "image position",
                          true,
                        )
                      }
                      onCommit={(value) =>
                        patchImage((candidate) => {
                          candidate.stage.position = [
                            candidate.stage.position[0],
                            value,
                            candidate.stage.position[2],
                          ];
                        }, "image position")
                      }
                    />
                    <InspectorSliderRow
                      icon={<ImageControlIcon type="depth" />}
                      label="Depth"
                      value={stage.position[2]}
                      min={-4}
                      max={4}
                      step={0.01}
                      onInput={(value) =>
                        patchImage(
                          (candidate) => {
                            candidate.stage.position = [
                              candidate.stage.position[0],
                              candidate.stage.position[1],
                              value,
                            ];
                          },
                          "image depth",
                          true,
                        )
                      }
                      onCommit={(value) =>
                        patchImage((candidate) => {
                          candidate.stage.position = [
                            candidate.stage.position[0],
                            candidate.stage.position[1],
                            value,
                          ];
                        }, "image depth")
                      }
                    />
                  </>
                )}
                {gizmoMode === "rotate" && (
                  <div className="inspector-pose-grid">
                    {(["X °", "Y °", "Z °"] as const).map((label, axis) => (
                      <NumberField
                        key={label}
                        label={label}
                        value={stage.rotationDeg[axis]}
                        decimals={1}
                        min={-180}
                        max={180}
                        step={1}
                        onCommit={(value) =>
                          patchImage((candidate) => {
                            const rotation: [number, number, number] = [
                              ...candidate.stage.rotationDeg,
                            ];
                            rotation[axis] = value;
                            candidate.stage.rotationDeg = rotation;
                          }, "image rotation")
                        }
                      />
                    ))}
                  </div>
                )}
                {gizmoMode === "scale" && (
                  <InspectorSliderRow
                    icon={<ImageControlIcon type="size" />}
                    label="Size"
                    value={stage.size}
                    min={0.05}
                    max={5}
                    step={0.01}
                    onInput={(value) =>
                      patchImage(
                        (candidate) => {
                          candidate.stage.size = value;
                        },
                        "image size",
                        true,
                      )
                    }
                    onCommit={(value) =>
                      patchImage((candidate) => {
                        candidate.stage.size = value;
                      }, "image size")
                    }
                  />
                )}
              </DrillGroup>
              <DrillGroup label="Shadow">
                <ToggleRow
                  label="Cast shadow"
                  description="Cast the image silhouette onto stage surfaces."
                  checked={image.castShadow ?? false}
                  onChange={(checked) =>
                    patchImage((candidate) => {
                      if (checked) candidate.castShadow = true;
                      else delete candidate.castShadow;
                    }, "image shadow")
                  }
                />
              </DrillGroup>
            </>
          ) : (
            <>
              <DrillGroup label="Placement">
                <InspectorSliderRow
                  icon={<ImageControlIcon type="x" />}
                  label="X"
                  value={overlay.position[0]}
                  min={-1}
                  max={1}
                  step={0.01}
                  onInput={(value) =>
                    patchImage(
                      (candidate) => {
                        candidate.overlay.position = [value, candidate.overlay.position[1]];
                      },
                      "image position",
                      true,
                    )
                  }
                  onCommit={(value) =>
                    patchImage((candidate) => {
                      candidate.overlay.position = [value, candidate.overlay.position[1]];
                    }, "image position")
                  }
                />
                <InspectorSliderRow
                  icon={<ImageControlIcon type="y" />}
                  label="Y"
                  value={overlay.position[1]}
                  min={-1}
                  max={1}
                  step={0.01}
                  onInput={(value) =>
                    patchImage(
                      (candidate) => {
                        candidate.overlay.position = [candidate.overlay.position[0], value];
                      },
                      "image position",
                      true,
                    )
                  }
                  onCommit={(value) =>
                    patchImage((candidate) => {
                      candidate.overlay.position = [candidate.overlay.position[0], value];
                    }, "image position")
                  }
                />
                <InspectorSliderRow
                  icon={<ImageControlIcon type="size" />}
                  label="Size"
                  value={overlay.size}
                  min={0.03}
                  max={0.6}
                  step={0.01}
                  onInput={(value) =>
                    patchImage(
                      (candidate) => {
                        candidate.overlay.size = value;
                      },
                      "image size",
                      true,
                    )
                  }
                  onCommit={(value) =>
                    patchImage((candidate) => {
                      candidate.overlay.size = value;
                    }, "image size")
                  }
                />
                <InspectorSliderRow
                  icon={<ImageControlIcon type="roll" />}
                  label="Roll"
                  value={overlay.rotationDeg}
                  min={-180}
                  max={180}
                  step={1}
                  onInput={(value) =>
                    patchImage(
                      (candidate) => {
                        candidate.overlay.rotationDeg = value;
                      },
                      "image roll",
                      true,
                    )
                  }
                  onCommit={(value) =>
                    patchImage((candidate) => {
                      candidate.overlay.rotationDeg = value;
                    }, "image roll")
                  }
                />
              </DrillGroup>
              <DrillGroup label="Appearance">
                <ToggleRow
                  label="Circle crop"
                  description="Crop the source to a circle."
                  checked={overlay.shape === "circle"}
                  onChange={(checked) =>
                    patchImage((candidate) => {
                      candidate.overlay.shape = checked ? "circle" : "none";
                    }, "image crop")
                  }
                />
                <SegmentedRow
                  options={[
                    { value: "above" as const, label: "Above" },
                    { value: "below" as const, label: "Below" },
                  ]}
                  value={overlay.layer}
                  onChange={(layer) =>
                    patchImage((candidate) => {
                      candidate.overlay.layer = layer;
                    }, "image layer")
                  }
                />
              </DrillGroup>
            </>
          )}

          {motionContent != null && <DrillGroup label="Motion">{motionContent}</DrillGroup>}
        </fieldset>
      </div>

      <div className="inspector-drill-actions">
        <button type="button" className="btn" disabled={duplicateDisabled} onClick={duplicate}>
          <FooterIcon type="duplicate" />
          Duplicate
        </button>
        <button type="button" className="btn danger" disabled={removeDisabled} onClick={remove}>
          <FooterIcon type="remove" />
          {removeConfirmImageId === image.id ? "Really remove?" : "Remove"}
        </button>
      </div>
    </div>
  );
}
