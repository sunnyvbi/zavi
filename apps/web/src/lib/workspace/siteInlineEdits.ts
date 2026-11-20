import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { announceSavingEdits, BUILD_CHANGES_LANDED_EVENT, BUILD_REFINE_STARTED_EVENT } from "@/lib/workspace/useBuildSession";
import { notifyBuildSessionsChanged } from "@/lib/workspace/useBuildSessions";

export function siteEditsAppId(siteId: string): string {
  return `site:${siteId.trim().toLowerCase()}`;
}

export type ApplySiteEditsResult =
  | { ok: true; applied: number; appliedSelectors: string[]; remaining: number; conductorRunId: string | null; direct: boolean; rowsDirect: number; rowsFallback: number; changeId?: string | null }
  | { ok: false; status: number; code: string | null; message: string };

export const APPLY_SITE_EDITS_FAILED = "We couldn't apply your edits. They're still saved. Try again.";
export const SITE_EDITS_NOTHING_APPLIED = "None of your changes were saved yet, so nothing was sent. Type them again, then press Send.";
export const APPLY_SITE_EDITS_UNREACHABLE = "We couldn't reach the server. Your edits are still saved. Try again.";

export type SiteTextEditSnapshot = { selector: string; text?: string; id?: string; updated_at?: string };

export async function applySiteEdits(appId: string, edits?: ReadonlyArray<SiteTextEditSnapshot>): Promise<ApplySiteEditsResult> {
  try {
    const res = await apiFetch("/api/website/site-edits/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, ...(edits ? { edits } : {}) }),
    });
    const body = (await res.json().catch(() => null)) as {
      applied?: unknown;
      applied_selectors?: unknown;
      remaining?: unknown;
      conductor_run_id?: unknown;
      direct?: unknown;
      rows_direct?: unknown;
      rows_fallback?: unknown;
      change_id?: unknown;
      error?: { code?: unknown; message?: unknown };
    } | null;
    if (!res.ok) {
      const code = typeof body?.error?.code === "string" ? body.error.code : null;
      const message = typeof body?.error?.message === "string" && body.error.message ? body.error.message : APPLY_SITE_EDITS_FAILED;
      return { ok: false, status: res.status, code, message: res.status === 403 && code === "forbidden" ? "Viewers can't apply edits. Ask a workspace owner, admin or member." : message };
    }
    return {
      ok: true,
      applied: typeof body?.applied === "number" ? body.applied : 0,
      appliedSelectors: Array.isArray(body?.applied_selectors) ? body.applied_selectors.filter((selector): selector is string => typeof selector === "string") : [],
      remaining: typeof body?.remaining === "number" ? body.remaining : 0,
      conductorRunId: typeof body?.conductor_run_id === "string" ? body.conductor_run_id : null,
      direct: body?.direct === true,
      rowsDirect: typeof body?.rows_direct === "number" ? body.rows_direct : 0,
      rowsFallback: typeof body?.rows_fallback === "number" ? body.rows_fallback : 0,
      changeId: typeof body?.change_id === "string" ? body.change_id : null,
    };
  } catch {
    return { ok: false, status: 0, code: null, message: APPLY_SITE_EDITS_UNREACHABLE };
  }
}

export function siteEditsAppliedDirectly(result: { direct?: boolean; conductorRunId?: string | null }): boolean {
  return result.direct === true && !result.conductorRunId;
}

export function siteEditsSendOutcome(result: ApplySiteEditsResult): { ok: true; direct?: true; applied: number; appliedSelectors: string[] } | { ok: false; message: string } {
  if (!result.ok) return { ok: false, message: result.message };
  if (result.applied <= 0) return { ok: false, message: SITE_EDITS_NOTHING_APPLIED };
  return siteEditsAppliedDirectly(result)
    ? { ok: true, direct: true, applied: result.applied, appliedSelectors: result.appliedSelectors }
    : { ok: true, applied: result.applied, appliedSelectors: result.appliedSelectors };
}

export async function sendSiteEditsOptimistic(
  appId: string,
  sessionId: string | null,
  count: number,
  onApplied: (result: { applied: number; direct?: boolean; conductorRunId?: string | null }) => void,
  edits?: ReadonlyArray<SiteTextEditSnapshot>,
): Promise<{ ok: true; direct?: true; applied: number; appliedSelectors: string[] } | { ok: false; message: string }> {
  const settle = startSavingEdits(sessionId, count);
  const result = await applySiteEdits(appId, edits);
  const outcome = siteEditsSendOutcome(result);
  if (outcome.ok && result.ok) onApplied(result);
  settle(outcome.ok && result.ok ? (result.changeId ?? result.conductorRunId) : null);
  return outcome;
}

export const SITE_EDITS_APPLY_PICKUP_MS = 60_000;
export const SAVING_EDITS_SETTLE_MS = 15_000;

export function appliedEditsLabel(count: number): string {
  return count === 1 ? "Applied 1 edit" : `Applied ${count} edits`;
}

export type SettleSavingChange = (outcome: string | null | { error: string }) => void;

const failedSavingChanges = new Map<string, Set<string>>();

function dropFailedSavingChanges(sessionId: string): void {
  const failed = failedSavingChanges.get(sessionId);
  if (!failed) return;
  failedSavingChanges.delete(sessionId);
  for (const id of failed) announceSavingEdits(sessionId, id, null);
}

export function startSavingChange(sessionId: string | null, message: string): SettleSavingChange {
  if (!sessionId || !message.trim()) return () => undefined;
  dropFailedSavingChanges(sessionId);
  const clientId = `saving:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const entry = { message, created_at: new Date().toISOString(), settledId: null };
  announceSavingEdits(sessionId, clientId, entry);
  return (outcome) => {
    if (outcome !== null && typeof outcome === "object") {
      announceSavingEdits(sessionId, clientId, { ...entry, failed: outcome.error });
      const failed = failedSavingChanges.get(sessionId) ?? new Set<string>();
      failed.add(clientId);
      failedSavingChanges.set(sessionId, failed);
      return;
    }
    if (!outcome) {
      announceSavingEdits(sessionId, clientId, null);
      return;
    }
    announceSavingEdits(sessionId, clientId, { ...entry, settledId: outcome });
    window.setTimeout(() => announceSavingEdits(sessionId, clientId, null), SAVING_EDITS_SETTLE_MS);
  };
}

export function startSavingEdits(sessionId: string | null, count: number): (settledId: string | null) => void {
  return startSavingChange(sessionId, count > 0 ? appliedEditsLabel(count) : "");
}

const siteEditsSessions = new Map<string, string>();

export function useSiteEditsSession(appId: string | null, sessionId: string | null): void {
  useEffect(() => {
    if (!appId || !sessionId) return;
    siteEditsSessions.set(appId, sessionId);
    return () => {
      if (siteEditsSessions.get(appId) === sessionId) siteEditsSessions.delete(appId);
    };
  }, [appId, sessionId]);
}

export const SITE_CHANGE_FAILED = "Your site wasn't changed. Try again.";

export function startSiteChangeInChat(appId: string, message: string): SettleSavingChange {
  const sessionId = siteEditsSessions.get(appId) ?? null;
  const settle = startSavingChange(sessionId, message);
  return (outcome) => {
    settle(outcome !== null && typeof outcome === "object" ? { error: outcome.error.trim() || SITE_CHANGE_FAILED } : outcome);
    if (sessionId && typeof outcome === "string" && outcome) {
      window.dispatchEvent(new CustomEvent(BUILD_CHANGES_LANDED_EVENT, { detail: { sessionId } }));
    }
  };
}

const THEME_COLOR_NAME: Record<string, string> = { primary: "brand", background: "page", foreground: "text", accent: "accent" };

function listed(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function themeChangeLabel(op: {
  colors?: Partial<Record<string, string>>;
  fonts?: { display?: string; body?: string };
  radius?: string;
  logo?: { preview_id: string } | { name_only: true };
}): string {
  const colors = Object.keys(op.colors ?? {}).filter((key) => THEME_COLOR_NAME[key]);
  const parts: string[] = [];
  if (colors.length === 1) parts.push(`${THEME_COLOR_NAME[colors[0]!]} colour`);
  else if (colors.length > 1) parts.push("colours");
  const display = !!op.fonts?.display;
  const body = !!op.fonts?.body;
  if (display && body) parts.push("fonts");
  else if (display) parts.push("heading font");
  else if (body) parts.push("body font");
  if (op.radius) parts.push("corners");
  if (op.logo) parts.push("logo");
  return parts.length ? `Changed the ${listed(parts)}` : "Changed the theme";
}

export function useSiteEditsApply(
  sessionId: string | null,
  building: boolean,
): { applying: boolean; onApplied: (result: { applied: number; direct?: boolean; conductorRunId?: string | null }) => void } {
  const [run, setRun] = useState<{ sessionId: string; seenRunning: boolean } | null>(null);
  const onApplied = useCallback(
    (result: { applied: number; direct?: boolean; conductorRunId?: string | null }) => {
      if (!sessionId || result.applied <= 0) return;
      if (siteEditsAppliedDirectly(result)) {
        notifyBuildSessionsChanged();
        window.dispatchEvent(new CustomEvent(BUILD_CHANGES_LANDED_EVENT, { detail: { sessionId } }));
        return;
      }
      setRun({ sessionId, seenRunning: false });
      notifyBuildSessionsChanged();
      window.dispatchEvent(new CustomEvent(BUILD_REFINE_STARTED_EVENT, { detail: { sessionId } }));
    },
    [sessionId],
  );
  useEffect(() => {
    if (!run) return;
    if (run.sessionId !== sessionId) {
      setRun(null);
      return;
    }
    if (building) {
      if (!run.seenRunning) setRun({ ...run, seenRunning: true });
      return;
    }
    if (run.seenRunning) {
      setRun(null);
      return;
    }
    const timer = window.setTimeout(() => setRun(null), SITE_EDITS_APPLY_PICKUP_MS);
    return () => window.clearTimeout(timer);
  }, [run, sessionId, building]);
  return { applying: run !== null && run.sessionId === sessionId, onApplied };
}
