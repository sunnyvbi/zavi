import { LINKEDIN_LAUNCH } from "@/services/ads-wallet/linkedin-growth";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { cgoApproveChannelAction, isFounderRequested } from "./cgo-ads";

export const LINKEDIN_LAUNCH_CLOSED_NOT_GO =
  "Zavi closed this launch because this run did not end on a go verdict for LinkedIn. Nothing was launched.";

export async function linkedinRunSaidGo(tenantId: string, runId: string | null): Promise<boolean> {
  if (!runId) return false;
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("agent_runs")
    .select("fit_verdict:parsed->fit->>verdict")
    .eq("id", runId)
    .maybeSingle();
  return !error && (data as { fit_verdict?: unknown } | null)?.fit_verdict === "here";
}

export const LINKEDIN_LAUNCH_NOT_STARTED =
  "Autopilot approved a LinkedIn Ads launch but could not start it. Nothing was launched or spent. Zavi has been alerted and will start it or close it";

async function runEnqueuedAt(tenantId: string, runId: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("agent_runs")
    .select("enqueued_at")
    .eq("id", runId)
    .maybeSingle();
  const at = (data as { enqueued_at?: unknown } | null)?.enqueued_at;
  return !error && typeof at === "string" ? at : null;
}

async function approveOrResend(tenantId: string, actionId: string): Promise<boolean> {
  try {
    return await cgoApproveChannelAction(tenantId, actionId, { runSaidGo: true });
  } catch (first) {
    console.warn(`[linkedin-run-verdict] launch ${actionId} approved, start not sent, retrying: ${(first as Error).message}`);
    return await cgoApproveChannelAction(tenantId, actionId, { runSaidGo: true });
  }
}

export async function settleLinkedinRunLaunchCards(
  tenantId: string,
  runId: string,
  fit: { verdict?: unknown; reason?: unknown } | null | undefined,
): Promise<{ approved: string[]; closed: string[]; unsent: string[] }> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("channel_actions")
    .select("id,run_id,created_at,exec_payload,edited_body")
    .eq("tenant_id", tenantId)
    .eq("exec_class", LINKEDIN_LAUNCH)
    .eq("status", "pending")
    .is("exec_status", null);
  if (error) throw new Error(`launch cards unread: ${error.message}`);
  const out = { approved: [] as string[], closed: [] as string[], unsent: [] as string[] };
  const go = fit?.verdict === "here";
  const closes = fit?.verdict === "not_here" || fit?.verdict === "unsure";
  const reason = typeof fit?.reason === "string" && fit.reason.trim() ? ` ${fit.reason.trim()}` : "";
  const rows = (data ?? []) as Array<{ id: string; run_id: string | null; created_at: string | null; exec_payload: unknown; edited_body: unknown }>;
  const earlierThan = closes && rows.some((r) => r.run_id !== runId) ? await runEnqueuedAt(tenantId, runId) : null;
  const earlier = (r: { created_at: string | null }) =>
    earlierThan !== null && typeof r.created_at === "string" && Date.parse(r.created_at) < Date.parse(earlierThan);
  for (const row of rows) {
    if (row.run_id !== runId && !(closes && earlier(row))) continue;
    if (row.edited_body != null) continue;
    const founderRooted = isFounderRequested(row.exec_payload);
    if (founderRooted && (go || (row.exec_payload as { explicit_order?: unknown } | null)?.explicit_order === true)) continue;
    if (go) {
      try {
        if (await approveOrResend(tenantId, row.id)) out.approved.push(row.id);
      } catch (e) {
        console.warn(`[linkedin-run-verdict] launch ${row.id} approved but not started: ${(e as Error).message}`);
        out.unsent.push(row.id);
      }
      continue;
    }
    if (!closes) continue;
    const closed = await tenantRpc(asTenantId(tenantId), "set_channel_action", {
      p_tenant_id: tenantId,
      p_action_id: row.id,
      p_status: "rejected",
      p_note: `${LINKEDIN_LAUNCH_CLOSED_NOT_GO}${reason}`,
      p_snoozed_until: null,
      p_event_key: `linkedin-run-not-go:${runId}:${row.id}`,
      p_actor_user_id: null,
      p_source: "cgo",
    });
    if (closed.error || (closed.data as { ok?: boolean } | null)?.ok !== true)
      throw new Error(`launch card ${row.id} not closed: ${closed.error?.message ?? (closed.data as { code?: string } | null)?.code}`);
    out.closed.push(row.id);
  }
  if (out.unsent.length) {
    const since = new Date().toISOString();
    const { alertFounderSafely } = await import("./cgo-blockers");
    await alertFounderSafely(
      tenantId,
      "linkedin launch not started",
      out.unsent.map((id) => ({
        id: `stuck:${id}`,
        kind: "stuck" as const,
        who: "zavi" as const,
        what: LINKEDIN_LAUNCH_NOT_STARTED,
        since,
        usd_at_stake: null,
        at_risk_now: false,
        notify_now: true,
        meanwhile: "nothing is spending while it waits",
        action_id: id,
        channel_slug: "linkedin_ads",
      })),
    );
  }
  return out;
}
