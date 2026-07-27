import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import {
  applyImport,
  discardStagedPack,
  inspectPack,
  type PackSelection,
  stageAndPlan,
} from "../../engine/packs";
import { PackGlyph } from "../PackGlyph";
import type { ImportOutcome, ImportPlan, PackInspection, PackProgress, Resolution } from "../types";
import { CodeView } from "./CodeView";
import { ConflictsView } from "./ConflictsView";
import { ContentsView } from "./ContentsView";
import { ErrorView } from "./ErrorView";
import { SummaryView } from "./SummaryView";
import { TrustView } from "./TrustView";

type Step =
  | { name: "choose" }
  | { name: "inspecting" }
  | { name: "trust" }
  | { name: "code" }
  | { name: "contents" }
  | { name: "staging"; progress: PackProgress | null }
  | { name: "conflicts"; plan: ImportPlan }
  | { name: "applying"; progress: PackProgress | null }
  | { name: "summary"; outcome: ImportOutcome }
  | { name: "error"; message: string };

/** Trust, then contents, then conflicts. Nothing is written to disk until the user has seen what is inside: staging happens on Continue from the contents screen, not earlier. */
export function ImportFlow({
  initialPath,
  queued,
  onClose,
}: {
  initialPath: string | null;
  queued: number;
  onClose: () => void;
}) {
  const [path, setPath] = useState<string | null>(initialPath);
  const [inspection, setInspection] = useState<PackInspection | null>(null);
  const [step, setStep] = useState<Step>(initialPath ? { name: "inspecting" } : { name: "choose" });

  useEffect(() => {
    setPath(initialPath);
    setStep(initialPath ? { name: "inspecting" } : { name: "choose" });
  }, [initialPath]);

  useEffect(() => {
    if (step.name !== "inspecting" || !path) return;
    let cancelled = false;
    inspectPack(path)
      .then((result) => {
        if (cancelled) return;
        setInspection(result);
        if (result.signature !== "valid") {
          setStep({
            name: "error",
            message:
              result.signature === "missing"
                ? "This pack is not signed. Kookaburra Cut only imports signed packs."
                : "This pack is damaged or has been modified since it was signed.",
          });
          return;
        }
        if (result.compatibility.kind === "needsNewerApp") {
          setStep({
            name: "error",
            message: `This pack needs Kookaburra Cut ${result.compatibility.min} or later.`,
          });
          return;
        }
        setStep({ name: "trust" });
      })
      .catch((e) => {
        if (!cancelled) setStep({ name: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [step.name, path]);

  const choose = useCallback(async () => {
    const picked = await open({
      title: "Import Pack",
      multiple: false,
      filters: [{ name: "Kookaburra Pack", extensions: ["kbpack"] }],
    });
    if (typeof picked === "string") {
      setPath(picked);
      setStep({ name: "inspecting" });
    }
  }, []);

  const runApply = useCallback(async (resolutions: Record<string, Resolution>) => {
    setStep({ name: "applying", progress: null });
    try {
      const outcome = await applyImport(resolutions, (progress) =>
        setStep({ name: "applying", progress }),
      );
      setStep({ name: "summary", outcome });
    } catch (e) {
      setStep({ name: "error", message: String(e) });
    }
  }, []);

  const onContents = useCallback(
    async (selection: PackSelection) => {
      if (!path) return;
      setStep({ name: "staging", progress: null });
      try {
        const plan = await stageAndPlan(path, selection, (progress) =>
          setStep({ name: "staging", progress }),
        );
        // An empty conflict screen tells the user nothing; skip straight to applying the defaults.
        if (plan.items.every((i) => i.state === "new")) {
          await runApply(
            Object.fromEntries(
              plan.items.map((i) => [`${i.kind}:${i.slug}`, "replace" as Resolution]),
            ),
          );
          return;
        }
        setStep({ name: "conflicts", plan });
      } catch (e) {
        setStep({ name: "error", message: String(e) });
      }
    },
    [path, runApply],
  );

  const cancelToClose = useCallback(() => {
    void discardStagedPack().catch(() => undefined);
    onClose();
  }, [onClose]);

  switch (step.name) {
    case "choose":
      return (
        <div className="packs-progress">
          <PackGlyph variant="import" />
          <div className="packs-hero-title">Import a pack</div>
          <div className="packs-hero-note">
            Drop a .kbpack file anywhere in this window, or choose one. Nothing is added to your
            workspace until you have seen what is inside.
          </div>
          <div className="packs-actions" style={{ justifyContent: "center", marginTop: 22 }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={() => void choose()}>
              Choose file…
            </button>
          </div>
        </div>
      );

    case "inspecting":
      return <Busy label="Checking the pack" />;

    case "trust":
      return inspection ? (
        <TrustView
          inspection={inspection}
          onViewCode={() => setStep({ name: "code" })}
          onCancel={onClose}
          onContinue={() => setStep({ name: "contents" })}
        />
      ) : (
        <Busy label="Checking the pack" />
      );

    case "code":
      return inspection && path ? (
        <CodeView
          path={path}
          manifest={inspection.manifest}
          onBack={() => setStep({ name: "trust" })}
        />
      ) : null;

    case "contents":
      return inspection ? (
        <ContentsView
          manifest={inspection.manifest}
          onBack={() => setStep({ name: "trust" })}
          onContinue={(selection) => void onContents(selection)}
        />
      ) : null;

    case "staging":
      return (
        <Busy label="Unpacking and verifying" progress={step.progress} onCancel={cancelToClose} />
      );

    case "conflicts":
      return (
        <ConflictsView
          plan={step.plan}
          onBack={() => {
            void discardStagedPack().catch(() => undefined);
            setStep({ name: "contents" });
          }}
          onApply={(resolutions) => void runApply(resolutions)}
        />
      );

    case "applying":
      return <Busy label="Adding to your workspace" progress={step.progress} />;

    case "summary":
      return (
        <SummaryView
          outcome={step.outcome}
          queued={queued}
          onOpenProject={(slug) => {
            void invoke("open_imported_project", { slug }).catch(() => undefined);
            onClose();
          }}
          onNextPack={() => void invoke("next_queued_pack")}
          onClose={onClose}
        />
      );

    case "error":
      return (
        <ErrorView
          message={step.message}
          path={path ?? undefined}
          onClose={onClose}
          onChooseAnother={() => setStep({ name: "choose" })}
        />
      );
  }
}

function Busy({
  label,
  progress,
  onCancel,
}: {
  label: string;
  progress?: PackProgress | null;
  onCancel?: () => void;
}) {
  const pct =
    progress && progress.totalBytes > 0
      ? Math.round((progress.bytes / progress.totalBytes) * 100)
      : progress && progress.total > 0
        ? Math.round((progress.file / progress.total) * 100)
        : 0;
  return (
    <div className="packs-progress">
      <div style={{ fontSize: 15 }}>{label}</div>
      <div className="packs-progress-bar">
        <div className="packs-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      {onCancel && (
        <div className="packs-actions" style={{ justifyContent: "center", marginTop: 20 }}>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
