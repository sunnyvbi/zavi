import { apiFetch } from "@/lib/api";
import { BUILD_RUN_RESUMED_EVENT } from "./buildPublish";

export type BuildPreviewRestartState = "starting" | "stopped";

export const BUILD_READY_PREVIEW_STOPPED =
  "Your app is built, but its preview stopped. Restart it from the preview, then press Publish to put it on its address.";

export const PREVIEW_RESTART_FAILED = "The preview didn't start. Try again.";

export function readPreviewRestartState(value: unknown): BuildPreviewRestartState | null {
  return value === "starting" || value === "stopped" ? value : null;
}

export type PreviewRestartResult = { ok: true } | { ok: false; message: string };

export async function restartBuildPreview(runId: string): Promise<PreviewRestartResult> {
  try {
    const res = await apiFetch("/api/workspace/autopilot/build-preview/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } } | null;
      const message = typeof body?.error?.message === "string" && body.error.message.trim() ? body.error.message : PREVIEW_RESTART_FAILED;
      return { ok: false, message };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "We couldn't reach the server. Try again." };
  } finally {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(BUILD_RUN_RESUMED_EVENT, { detail: { runId } }));
    }
  }
}
