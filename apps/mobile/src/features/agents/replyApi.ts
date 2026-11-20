import { apiJson } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import type { StructuredAnswer } from "./replyCards";
import type { Schedule } from "./schedule";

const agentPath = (slug: string, rest: string) => `/api/agents/${encodeURIComponent(slug)}${rest}`;

export function submitClarify(
  slug: string,
  requestId: string,
  answers: StructuredAnswer[],
): Promise<{ run_id: string }> {
  return apiJson(agentPath(slug, "/clarify-submit"), {
    method: "POST",
    body: JSON.stringify({ request_id: requestId, answers }),
  });
}

export async function fetchClarifySubmitted(requestId: string): Promise<boolean> {
  const { data } = await supabase
    .from("agent_clarification_responses")
    .select("status")
    .eq("request_id", requestId)
    .maybeSingle();
  const status = (data as { status?: string } | null)?.status;
  return status === "submitted" || status === "consumed";
}

export function submitSetup(
  slug: string,
  vault: Record<string, string>,
): Promise<{ retry: { ok: boolean; run_id?: string; error?: string } | null }> {
  return apiJson(agentPath(slug, "/setup"), {
    method: "POST",
    body: JSON.stringify({ vault, retry: true }),
  });
}

export function fetchSchedule(slug: string): Promise<{ schedule: Schedule | null; warning?: string }> {
  return apiJson(agentPath(slug, "/schedule"));
}

export function saveSchedule(
  slug: string,
  body: { cron_expression: string; enabled: boolean; timezone?: string },
): Promise<{ ok?: boolean; warning?: string }> {
  return apiJson(agentPath(slug, "/schedule"), { method: "PUT", body: JSON.stringify(body) });
}

export function deleteSchedule(slug: string): Promise<unknown> {
  return apiJson(agentPath(slug, "/schedule"), { method: "DELETE" });
}

export function runAgentNow(slug: string): Promise<{ run_id?: string }> {
  return apiJson(agentPath(slug, "/run"), { method: "POST", body: JSON.stringify({}), idempotent: true });
}

export type SharedPage = {
  id: string;
  run_id: string;
  title: string;
  visibility: "private" | "public";
  public_url: string | null;
  expires_at: string | null;
  created_at: string;
};

export function fetchSharedPages(runId: string): Promise<{ pages?: SharedPage[] }> {
  return apiJson(`/api/workspace/shared-pages?run_id=${encodeURIComponent(runId)}`);
}

export function changeSharedPage(id: string, action: "publish" | "revoke"): Promise<{ page?: SharedPage }> {
  return apiJson(`/api/workspace/shared-pages/${encodeURIComponent(id)}/${action}`, { method: "POST" });
}

const previewPath = (id: string) => `/api/workspace/engineer/html-preview/${encodeURIComponent(id)}`;

export async function fetchHtmlPreview(id: string): Promise<string> {
  const body = await apiJson<{ state?: string; html?: unknown }>(previewPath(id));
  if (body?.state !== "html_preview_ready" || typeof body.html !== "string") {
    throw new Error("Preview artifact is not ready.");
  }
  return body.html;
}

export function ackHtmlPreviewDisplayed(id: string): Promise<unknown> {
  return apiJson(`${previewPath(id)}/displayed`, { method: "POST" });
}

export function fetchBuildStatus(): Promise<{ preview?: { url?: string | null; kind?: string } | null }> {
  return apiJson("/api/workspace/autopilot/build-status");
}
