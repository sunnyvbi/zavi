import { apiJson } from "../../lib/api";
import { IDEMPOTENCY_HEADER, newIdempotencyKey } from "../../lib/apiRetry";
import type {
  BuildRefine,
  BuildSessionsResponse,
  BuildStatusResponse,
  BuiltinUrl,
  ExportRecord,
  ExportResult,
  PublishStatus,
  Visibility,
} from "./logic";
import {
  RATINGS_BATCH_MAX,
  ratingBody,
  readSavedRatings,
  type BuildRatingValue,
  type BuildReasonId,
  type SavedRating,
} from "./feedback";
import { readSiteDesign, type SiteDesign } from "./siteDesign";
import { readSiteTemplates, type SiteTemplate } from "./templates";
import { readLogoPreview, readSiteTheme, type LogoPreview, type SiteThemeState, type SiteThemeTokens, type ThemeOp } from "./siteTheme";

const AP = "/api/workspace/autopilot";
const enc = encodeURIComponent;
const post = <T>(path: string, body?: Record<string, unknown>) =>
  apiJson<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export function fetchBuildSessions(): Promise<BuildSessionsResponse> {
  return apiJson<BuildSessionsResponse>(`${AP}/build-sessions`);
}

export async function startBuild(input: { idea: string; companyName: string; template?: string | null }): Promise<string> {
  const body = await post<{ conductor_run_id?: string }>(`${AP}/build-product`, {
    idea: input.idea.trim(),
    company_name: input.companyName.trim(),
    ...(input.template ? { template: input.template } : {}),
    await_look_pick: true,
  });
  if (typeof body?.conductor_run_id !== "string" || !body.conductor_run_id) {
    throw new Error("The build didn't start. Please try again.");
  }
  return body.conductor_run_id;
}

export function fetchBuildStatus(runId: string): Promise<BuildStatusResponse> {
  return apiJson<BuildStatusResponse>(`${AP}/build-status?run_id=${enc(runId)}`);
}

export function cancelBuild(runId: string): Promise<unknown> {
  return post(`${AP}/runs/${enc(runId)}/cancel`);
}

export function continueBuild(runId: string): Promise<unknown> {
  return post(`${AP}/runs/${enc(runId)}/continue`);
}

export async function fetchRefines(sessionId: string): Promise<BuildRefine[]> {
  const body = await apiJson<{ refines?: BuildRefine[] }>(`${AP}/refines?session_id=${enc(sessionId)}`);
  return Array.isArray(body?.refines) ? body.refines : [];
}

export function sendChange(sessionId: string, message: string): Promise<unknown> {
  return post(`${AP}/refine-product`, { message: message.trim(), conductor_run_id: sessionId });
}

export async function fetchBuiltinUrl(): Promise<BuiltinUrl | null> {
  const body = await apiJson<{ builtin?: BuiltinUrl | null }>("/api/website/builtin-url");
  return body?.builtin ?? null;
}

export async function ensureBuiltinUrl(): Promise<BuiltinUrl | null> {
  const body = await post<{ builtin?: BuiltinUrl | null }>("/api/website/builtin-url/ensure");
  return body?.builtin ?? null;
}

export function fetchPublishStatus(appHost: string): Promise<PublishStatus> {
  return apiJson<PublishStatus>(`/api/website/publish-status?app=${enc(appHost)}`);
}

export function publishEdits(appHost: string): Promise<unknown> {
  return post("/api/website/publish", { app_id: appHost });
}

export function unpublishEdits(appHost: string): Promise<unknown> {
  return post("/api/website/unpublish", { app_id: appHost });
}

export async function fetchVisibility(): Promise<Visibility> {
  const body = await apiJson<{ visibility?: Visibility }>("/api/website/overview?app=workspace");
  return body?.visibility ?? "public";
}

export async function saveVisibility(visibility: Visibility): Promise<Visibility> {
  const body = await post<{ visibility?: Visibility }>("/api/website/settings", { visibility });
  return body?.visibility ?? visibility;
}

export async function fetchExport(runId: string | null): Promise<ExportRecord | null> {
  const q = runId ? `?conductor_run_id=${encodeURIComponent(runId)}` : "";
  const body = await apiJson<{ export?: ExportRecord | null }>(`/api/workspace/export-github${q}`);
  return body?.export ?? null;
}

export function runExport(destRepoName: string, runId: string | null): Promise<ExportResult> {
  const name = destRepoName.trim();
  return post<ExportResult>("/api/workspace/export-github", {
    ...(name ? { dest_repo_name: name } : {}),
    ...(runId ? { conductor_run_id: runId } : {}),
  });
}

export async function rateBuild(
  runId: string,
  rating: BuildRatingValue,
  comment: string | null,
  reasons: BuildReasonId[],
): Promise<{ carryover: boolean }> {
  const body = await post<{ carryover?: boolean }>("/api/feedback", ratingBody(runId, rating, comment, reasons));
  return { carryover: body?.carryover === true };
}

export async function fetchMyBuildRatings(ids: string[]): Promise<Record<string, SavedRating>> {
  const out: Record<string, SavedRating> = {};
  for (let i = 0; i < ids.length; i += RATINGS_BATCH_MAX) {
    const chunk = ids.slice(i, i + RATINGS_BATCH_MAX);
    const body = await apiJson<unknown>(`/api/feedback/mine?target_type=conductor_run&ids=${chunk.map(enc).join(",")}`);
    Object.assign(out, readSavedRatings(body));
  }
  return out;
}

export async function fetchSiteDesign(runId: string): Promise<SiteDesign | null> {
  try {
    return readSiteDesign(await apiJson<unknown>(`${AP}/site-design?run_id=${enc(runId)}`), Date.now());
  } catch (e) {
    if ((e as { status?: number } | null)?.status === 404) return null;
    throw e;
  }
}

export async function pickLook(runId: string, lookId: string): Promise<SiteDesign | null> {
  const body = await post<unknown>(`${AP}/site-design/direction`, { run_id: runId, direction: lookId });
  return readSiteDesign(body, Date.now());
}

export async function fetchSiteTemplates(): Promise<SiteTemplate[]> {
  const list = readSiteTemplates(await apiJson<unknown>("/api/public/site-templates"));
  if (list.length === 0) throw new Error("No templates");
  return list;
}

export async function fetchSiteTheme(appId: string): Promise<SiteThemeState> {
  return readSiteTheme(await apiJson<unknown>(`/api/website/site-design-edit?app_id=${enc(appId)}`));
}

const DESIGN_EDIT_SETTLE_ATTEMPTS = 225;
const DESIGN_EDIT_SETTLE_MS = 1000;

async function postDesignEdit<T>(appId: string, op: Record<string, unknown>): Promise<T> {
  const key = newIdempotencyKey();
  for (let attempt = 0; ; attempt++) {
    try {
      return await apiJson<T>("/api/website/site-design-edit", {
        method: "POST",
        idempotent: true,
        headers: { [IDEMPOTENCY_HEADER]: key },
        body: JSON.stringify({ app_id: appId, op }),
      });
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== "idempotency_in_progress" || attempt >= DESIGN_EDIT_SETTLE_ATTEMPTS) throw e;
      await new Promise((r) => setTimeout(r, DESIGN_EDIT_SETTLE_MS));
    }
  }
}

export async function saveSiteTheme(appId: string, op: ThemeOp): Promise<SiteThemeTokens | null> {
  const body = await postDesignEdit<{ theme?: unknown }>(appId, op);
  return readSiteTheme({ theme: body?.theme }).theme;
}

export async function previewSiteLogo(
  appId: string,
  description: string,
  colors: { primary: string; accent: string } | null,
): Promise<LogoPreview> {
  const body = await postDesignEdit<unknown>(appId, { kind: "logo_preview", description, ...(colors ? { colors } : {}) });
  const preview = readLogoPreview(body);
  if (!preview) throw new Error("We couldn't save that change. Try again, or ask for it in the chat.");
  return preview;
}
