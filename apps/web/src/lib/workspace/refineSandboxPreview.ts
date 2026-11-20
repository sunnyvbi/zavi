import type { BuildRefine } from "./useBuildSession";
import type { PreviewPanel } from "@/components/workspace/previewPanelState";

const TERMINAL = new Set(["done", "failed", "halted", "paused", "cancelled", "canceled"]);

export function refineSandboxPreviewRunId(refines: ReadonlyArray<BuildRefine>): string | null {
  const latest = refines[refines.length - 1];
  if (!latest) return null;
  if (latest.kind && latest.kind !== "change") return null;
  if (TERMINAL.has(latest.status)) return null;
  if (latest.awaiting_review === true) return null;
  const runId = latest.engineer_run_id;
  return typeof runId === "string" && runId.length > 0 ? runId : null;
}

export function nextSandboxFrameUrl(current: string | null, panel: PreviewPanel): string | null {
  if (panel.kind !== "live") return null;
  return current ?? panel.proxyUrl;
}
