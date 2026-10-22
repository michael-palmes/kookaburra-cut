import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseProjectId } from "../engine/project";
import { type SceneWizardRequest, useUiStore } from "../store/uiStore";
import { HelperWizard } from "./HelperWizards";
import { PresetGalleryModal } from "./PresetGalleryModal";
import { EditSceneWizard, sceneIndexAtPlayhead, type WizardSceneInfo } from "./SceneWizards";

/** The scene wizards (Add a scene, Edit scene and the prompt helpers), hosted at the app level so they work whether Claude runs in its own app or the legacy terminal rail; any surface opens one through `useUiStore.requestSceneWizard`. */
export function SceneWizardHost({
  slug,
  cwd,
  scenes,
  readThumbs,
  captureThumbs,
  onProjectChanged,
  onHelperPrompt,
}: {
  /** Workspace project slug. */
  slug: string;
  /** Absolute project path. */
  cwd: string;
  /** The loaded project's scenes, for the pickers and scene-aware dropdowns. */
  scenes: WizardSceneInfo[];
  /** Scene-picker thumbnails straight from the cache: no capture, no clock borrow. */
  readThumbs: () => Promise<Record<string, string>>;
  /** Capture the scene-picker thumbnails that are missing or stale (borrows the preview clock). */
  captureThumbs: (signal?: AbortSignal) => Promise<Record<string, string>>;
  /** A native write changed project.json/scenes; reload the preview immediately. `focusSceneFile` lands the playhead on that scene after the reload. */
  onProjectChanged: (focusSceneFile?: string) => void;
  /** A helper wizard composed a prompt for Claude. */
  onHelperPrompt: (prompt: string) => void;
}) {
  const scope = parseProjectId(slug).scope;
  const canAddScenes = scope !== "preset" && scope !== "ws-preset";
  const [wizard, setWizard] = useState<SceneWizardRequest | null>(null);
  const [newScenePosition, setNewScenePosition] = useState(0);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  // Via a ref so a rebuilt scenes array can't churn the wizard callbacks' identity.
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;

  /** Cards fill in progressively, so a later listing only ever adds to what is already showing. */
  const addThumbs = useCallback((next: Record<string, string>) => {
    setThumbs((prev) => ({ ...prev, ...next }));
  }, []);

  // Stable request handle: wizards fire it when their thumb grid mounts, so a re-identified `captureThumbs` prop can't re-trigger their step effects.
  const captureRef = useRef(captureThumbs);
  useEffect(() => {
    captureRef.current = captureThumbs;
  });
  const thumbsAbort = useRef<AbortController | null>(null);
  const needThumbs = useCallback(() => {
    thumbsAbort.current?.abort();
    const controller = new AbortController();
    thumbsAbort.current = controller;
    captureRef
      .current(controller.signal)
      .then(addThumbs)
      .catch(() => {});
  }, [addThumbs]);

  /** Open a wizard, painting cached thumbs immediately AND submitting the stale ones straight away: the render window captures in the background (never the editor's clock, which the old pipeline scrubbed), so by the placement step the fresh thumbs are usually already in. */
  const openSceneWizard = useCallback(
    (which: SceneWizardRequest) => {
      if (!canAddScenes && which === "new-scene") return;
      if (which === "new-scene") {
        setNewScenePosition(sceneIndexAtPlayhead(scenesRef.current) + 1);
      }
      setWizard(which);
      if (which !== "new-scene" && which !== "edit-scene") return;
      readThumbs()
        .then(addThumbs)
        .catch(() => {});
      if (which === "edit-scene") needThumbs();
    },
    [readThumbs, addThumbs, needThumbs, canAddScenes],
  );
  // A closed wizard's queued thumbs are cancelled rather than left draining for nobody.
  useEffect(() => {
    if (wizard === null) thumbsAbort.current?.abort();
    const holder = thumbsAbort;
    return () => holder.current?.abort();
  }, [wizard]);
  // Fresh thumbs land asynchronously from the render window; repaint open grids as they arrive (only while a wizard is open, since the host stays mounted).
  const readRef = useRef(readThumbs);
  useEffect(() => {
    readRef.current = readThumbs;
  });
  const wizardOpen = wizard !== null;
  useEffect(() => {
    if (!wizardOpen) return;
    const stop = listen("kookaburra://thumbs-updated", () => {
      readRef
        .current()
        .then(addThumbs)
        .catch(() => {});
    });
    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, [addThumbs, wizardOpen]);

  const request = useUiStore((s) => s.sceneWizardRequest);
  useEffect(() => {
    if (!request) return;
    openSceneWizard(request);
    useUiStore.getState().requestSceneWizard(null);
  }, [request, openSceneWizard]);

  if (wizard === "new-scene" && canAddScenes) {
    return (
      <PresetGalleryModal
        slug={slug}
        position={newScenePosition}
        scenes={scenes}
        thumbs={thumbs}
        onNeedThumbs={needThumbs}
        onDone={(result) => {
          setWizard(null);
          onProjectChanged(result.file);
        }}
        onCancel={() => setWizard(null)}
      />
    );
  }
  if (wizard === "edit-scene") {
    return (
      <EditSceneWizard
        slug={slug}
        projectPath={cwd}
        scenes={scenes}
        thumbs={thumbs}
        onNeedThumbs={needThumbs}
        onSaved={() => {
          setWizard(null);
          onProjectChanged();
        }}
        onCancel={() => setWizard(null)}
      />
    );
  }
  if (wizard && wizard !== "new-scene") {
    return (
      <HelperWizard
        kind={wizard}
        scenes={scenes}
        slug={slug}
        onInsert={(prompt) => {
          setWizard(null);
          onHelperPrompt(prompt);
        }}
        onCancel={() => setWizard(null)}
      />
    );
  }
  return null;
}
