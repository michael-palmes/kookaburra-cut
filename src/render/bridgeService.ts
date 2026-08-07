import { invoke } from "@tauri-apps/api/core";
import { resolveScreenshotTimeMs } from "../engine/autorun";
import { awaitSceneHostsCommitted, captureScreenshot } from "../engine/exporter";
import { type AspectName, FORMATS, type FormatSpec, FPS } from "../engine/format";
import {
  bumpWorkspaceReloadToken,
  isWorkspaceProjectId,
  type LoadedProject,
  loadProject,
  workspaceSlug,
} from "../engine/project";
import { awaitProjectCommitted } from "../engine/themePreviews";

/** The render window's half of the capture bridge: claim one request per tick, load (or reload) the target project into this window's own canvas, render the frame through the deterministic export path and respond, all without touching the editor realm. Requests with an explicit --scene may target any project on disk; playhead requests (no scene) need the editor's open project, whose id/aspect/playhead arrive via the pushed editor context. */

interface BridgeRequest {
  version: number;
  id: string;
  project?: string | null;
  scene?: string | null;
  at?: number | null;
  requestedAtMs: number;
}

/** Mirror of bridge.rs's EditorContext. */
interface EditorContext {
  projectId: string | null;
  aspect: string;
  currentMs: number;
  exportLocked: boolean;
}

const BRIDGE_COMMANDS = { begin: "begin_bridge_screenshot", save: "save_bridge_screenshot" };

interface LoadedState {
  project: LoadedProject;
  fingerprint: string | null;
  formatName: string;
}

/** Starts the claim loop; returns its stop function. `apply` lands a loaded project in this window's stores and React tree (RenderApp owns that state). */
export function startBridgeService(
  apply: (loaded: LoadedProject, format: FormatSpec) => void,
): () => void {
  let busy = false;
  let current: LoadedState | null = null;

  const serve = async (): Promise<void> => {
    let request: BridgeRequest | null = null;
    try {
      request = await invoke<BridgeRequest | null>("bridge_claim_request");
    } catch {
      return;
    }
    if (!request) return;
    const id = request.id;
    const respond = (body: Record<string, unknown>) =>
      invoke("bridge_write_response", {
        id,
        jsonText: JSON.stringify({ version: 1, id, ...body }),
      }).catch((e) => console.warn("[render-bridge] response write failed:", e));

    try {
      const context = await invoke<EditorContext | null>("get_editor_context").catch(() => null);
      if (context?.exportLocked) {
        await respond({
          ok: false,
          busy: true,
          error: "Kookaburra Cut is exporting right now; retry shortly",
        });
        return;
      }
      const targetId = request.project ?? context?.projectId ?? null;
      if (!targetId) {
        await respond({
          ok: false,
          error:
            "no project is open in Kookaburra Cut; open one (or pass --scene with an explicit project) and retry",
        });
        return;
      }
      if (!request.scene && targetId !== context?.projectId) {
        await respond({
          ok: false,
          error: `requested project "${targetId}" isn't open (currently open: "${context?.projectId ?? "none"}"); playhead captures need the open project, or pass --scene to capture any project`,
        });
        return;
      }

      const fingerprint = isWorkspaceProjectId(targetId)
        ? await invoke<string>("project_fingerprint", { slug: workspaceSlug(targetId) }).catch(
            () => null,
          )
        : null;
      const formatName = (context?.aspect ?? "16:9") as AspectName;
      const format = FORMATS[formatName] ?? FORMATS["16:9"];
      if (
        !current ||
        current.project.id !== targetId ||
        current.fingerprint !== fingerprint ||
        current.formatName !== format.name
      ) {
        bumpWorkspaceReloadToken();
        const loaded = await loadProject(targetId);
        apply(loaded, format);
        await awaitProjectCommitted(loaded);
        await awaitSceneHostsCommitted(loaded.slots.length);
        current = { project: loaded, fingerprint, formatName: format.name };
      }

      const project = current.project;
      const tMs = resolveScreenshotTimeMs(
        project,
        request.scene ?? undefined,
        request.at ?? undefined,
        targetId === context?.projectId ? context.currentMs : undefined,
      );
      const path = await captureScreenshot(
        {
          projectId: project.id,
          fps: FPS,
          durationMs: project.totalMs,
          slots: project.slots,
          cameraTrack: project.cameraTrack,
          sceneDocs: project.sceneDocs,
          theme: project.theme,
          sceneThemes: project.sceneThemes,
          projectLighting: project.projectLighting,
          sceneFrames: project.sceneFrames,
          compareBDocs: project.compareBDocs,
          compareBThemes: project.compareBThemes,
          codec: "libx264",
          format,
        },
        tMs,
        id,
        BRIDGE_COMMANDS,
      );
      await respond({
        ok: true,
        path,
        project: project.id,
        tMs: Math.round(tMs),
        format: format.name,
        // Provenance for hash disputes: this surface is visually exact but not hash-exact against the cold-boot screenshot (docs/determinism.md).
        surface: "render-window",
      });
    } catch (e) {
      // A failed load poisons nothing: drop the cached project so the next request reloads cold.
      current = null;
      await respond({ ok: false, error: String(e) });
    }
  };

  const timer = window.setInterval(() => {
    if (busy) return;
    busy = true;
    void serve().finally(() => {
      busy = false;
    });
  }, 1000);
  return () => window.clearInterval(timer);
}
