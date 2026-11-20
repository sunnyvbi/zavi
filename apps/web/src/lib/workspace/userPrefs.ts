
import { createBrowserSupabase } from "@/lib/supabase";
import type { WorkspacePrefs, WorkspaceViewMode } from "./types";

export const DEFAULT_VIEW_MODE: WorkspaceViewMode = "chat";
export const DEFAULT_PANE_WIDTH_PCT = 50;
export const MIN_PANE_WIDTH_PCT = 20;
export const MAX_PANE_WIDTH_PCT = 80;

export function clampPaneWidthPct(pct: number): number {
  if (!Number.isFinite(pct)) return DEFAULT_PANE_WIDTH_PCT;
  return Math.min(MAX_PANE_WIDTH_PCT, Math.max(MIN_PANE_WIDTH_PCT, pct));
}

export function normalizeWorkspacePrefs(
  raw: WorkspacePrefs | null | undefined,
): { viewMode: WorkspaceViewMode; paneWidthPct: number } {
  const viewMode =
    raw?.viewMode === "threaded" || raw?.viewMode === "chat"
      ? raw.viewMode
      : DEFAULT_VIEW_MODE;
  const paneWidthPct =
    typeof raw?.paneWidthPct === "number"
      ? clampPaneWidthPct(raw.paneWidthPct)
      : DEFAULT_PANE_WIDTH_PCT;
  return { viewMode, paneWidthPct };
}

export async function writeUserPref(
  key: "viewMode",
  value: WorkspaceViewMode,
): Promise<void>;
export async function writeUserPref(
  key: "paneWidthPct",
  value: number,
): Promise<void>;
export async function writeUserPref(
  key: "viewMode" | "paneWidthPct",
  value: WorkspaceViewMode | number,
): Promise<void> {
  const supabase = createBrowserSupabase();
  const { error } = await supabase.rpc("set_user_pref", {
    p_key: key,
    p_value: value,
  });
  if (error) {
    throw new Error(`set_user_pref(${key}) failed: ${error.message}`);
  }
}
