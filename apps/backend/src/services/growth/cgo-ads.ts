
import { isPersonOnlyOrigin } from "./person-only";
import { BUDGET_TEST_REVERT } from "./budget-test-shape";
const LINKEDIN_LAUNCH_CLASS = "linkedin_ads.launch_campaign";
import { readActiveAdBudget, type ActiveAdBudget } from "@/services/decisions/ad-budget";
import { ASSISTANT_AD_CHANGE } from "@/services/mcp/assistant-policy";
import { asTenantId, tenantClient } from "@/services/tenant-client";

export const CGO_AD_CHANNELS: ReadonlySet<string> = new Set(["meta_ads", "google_ads", "youtube_ads", "chatgpt_ads", "reddit_ads", "x_ads", "tiktok_ads", "linkedin_ads"]);

export { isExecutableAdClass } from "./unattended-policy";

export async function cgoAdBudget(tenant_id: string, _now: Date = new Date()): Promise<ActiveAdBudget | null> {
  try {
    const budget = await readActiveAdBudget(tenant_id);
    if (!budget) return null;
    const { getBoolSettingStrictResolved } = await import("@/services/settings");
    return (await getBoolSettingStrictResolved("cgo_autopilot_enabled", tenant_id)) ? budget : null;
  } catch (e) {
    console.warn(`[cgo-ads] could not tell whether cgo runs ads for ${tenant_id}; it does not: ${(e as Error).message}`);
    return null;
  }
}

export function isTestRevertCard(body: unknown): boolean {
  return !!body && typeof body === "object" && typeof (body as Record<string, unknown>).test_revert_of === "string";
}

export function isFounderRequested(body: unknown): boolean {
  return isPersonOnlyOrigin((body as { origin?: unknown } | null)?.origin);
}

const FOUNDERS_OWN: ReadonlySet<string> = new Set(["founder_staged_change", "founder_requested_change", ASSISTANT_AD_CHANGE]);

async function unattendedAllows(
  tenant_id: string,
  action: import("./unattended-policy").UnattendedAction & { kind: "ad" },
  onHeld?: (reasons: string[]) => void,
  shownInChat?: () => Promise<boolean>,
): Promise<boolean> {
  const { authorizeUnattended, askFounderAboutHeld, recordCardHold } = await import("./unattended-policy");
  const v = await authorizeUnattended(tenant_id, action, { where: "door" });
  if (v.verdict === "allow") return true;
  const held = v.verdict === "ask_founder" || (v.verdict === "deny" && !v.reasons.every((r) => FOUNDERS_OWN.has(r)));
  if (onHeld) {
    if (held) await recordCardHold(tenant_id, action.source, v);
    onHeld(v.reasons);
    return false;
  }
  if (held) {
    const conflict = v.reasons.includes("open_advice_conflict");
    if (shownInChat && !conflict && (await recordCardHold(tenant_id, action.source, v)) && (await shownInChat())) return false;
    await askFounderAboutHeld(tenant_id, action, v);
  }
  return false;
}

export async function cgoApproveAdDecision(
  tenant_id: string,
  decision_id: string,
  decision_class: string,
  body: unknown,
  agent_slug?: string,
  opts: {
    onHeld?: (reasons: string[]) => void;
    shownInChat?: () => Promise<boolean>;
  } = {},
): Promise<boolean> {
  try {
    const { isExecutableAdClass } = await import("./unattended-policy");
    if (!isExecutableAdClass(decision_class) || isFounderRequested(body)) return false;
    if (agent_slug && !CGO_AD_CHANNELS.has(agent_slug)) {
      const { isChannelAgent } = await import("@/services/agents/channel-agents");
      if (isChannelAgent(agent_slug)) return false;
    }
    if (!(await cgoAdBudget(tenant_id))) return false;
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("decisions")
      .select("status, agent_run_id")
      .eq("id", decision_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    const row = data as { status?: string; agent_run_id?: string | null } | null;
    if (error || row?.status !== "proposed") return false;
    const action = {
      kind: "ad" as const,
      exec_class: decision_class,
      payload: body,
      source: { table: "decisions" as const, id: decision_id, run_id: row.agent_run_id ?? null },
    };
    if (!(await unattendedAllows(tenant_id, action, opts.onHeld, opts.shownInChat))) return false;
    const { approveDecisionAsCgo } = await import("./cgo-auto-run");
    return await approveDecisionAsCgo(tenant_id, decision_id, decision_class, {
      code: "cgo.ad_decision_approved",
      message: "ads decision approved by cgo (autopilot, ad budget on)",
    });
  } catch (e) {
    console.warn(`[cgo-ads] decision ${decision_id} left for the founder: ${(e as Error).message}`);
    return false;
  }
}

export async function cgoApproveChannelAction(tenant_id: string, action_id: string, opts: { onHeld?: (reasons: string[]) => void; runSaidGo?: boolean } = {}): Promise<boolean> {
  let pendingSend: { id: string; action_id: string } | null = null;
  let exec_class = "";
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("channel_actions")
      .select("channel_slug, run_id, title, exec_class, exec_payload, exec_status, status, approved_by_source, edited_body, body")
      .eq("id", action_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (error || !data) return false;
    const row = data as {
      channel_slug: string;
      run_id: string | null;
      title: string | null;
      exec_class: string | null;
      exec_payload: unknown;
      exec_status: string | null;
      status: string;
      approved_by_source: string | null;
      edited_body?: unknown;
      body?: unknown;
    };
    const { isExecutableAdClass } = await import("./unattended-policy");
    if (!CGO_AD_CHANNELS.has(row.channel_slug) || !row.exec_class || !isExecutableAdClass(row.exec_class)) return false;
    if (isFounderRequested(row.exec_payload) || row.edited_body != null) return false;
    if (isTestRevertCard(row.body)) {
      opts.onHeld?.([BUDGET_TEST_REVERT]);
      return false;
    }
    exec_class = row.exec_class;
    const resend = row.exec_status === "queued" && row.approved_by_source === "cgo";
    if ((row.exec_status !== null && !resend) || row.status !== "pending") return false;
    if (!(await cgoAdBudget(tenant_id))) return false;
    if (row.exec_class === LINKEDIN_LAUNCH_CLASS && !opts.runSaidGo) {
      const { linkedinRunSaidGo } = await import("./linkedin-run-verdict");
      if (!(await linkedinRunSaidGo(tenant_id, row.run_id))) return false;
    }
    const action = {
      kind: "ad" as const,
      exec_class: row.exec_class,
      payload: row.exec_payload,
      source: { table: "channel_actions" as const, id: action_id, run_id: row.run_id },
      title: row.title,
    };
    if (!resend && !(await unattendedAllows(tenant_id, action, opts.onHeld))) return false;
    const { tenantOwnerId } = await import("./cgo-auto-run");
    const { approveChannelAction } = await import("@/services/channels/exec-actions");
    const owner = await tenantOwnerId(tenant_id);
    if (!owner) return false;
    const result = await approveChannelAction(tenant_id, {
      actionId: action_id,
      eventKey: `cgo:${action_id}`,
      actorUserId: owner,
      source: "cgo",
    });
    if (!result.ok) {
      console.warn(`[cgo-ads] approve of channel action ${action_id} refused: ${result.code}`);
      return false;
    }
    if (!result.replayed || result.stillQueued || resend) {
      pendingSend = { id: `approve:${action_id}:${result.attempt}`, action_id };
    }
  } catch (e) {
    console.warn(`[cgo-ads] channel action ${action_id} left for the founder: ${(e as Error).message}`);
    return false;
  }
  if (pendingSend) {
    const { inngest } = await import("@/../workers/client");
    await inngest.send({ id: pendingSend.id, name: "channel-action.approved", data: { action_id } });
  }
  try {
    const { logEvent } = await import("@/services/logging/logEvent");
    await logEvent({
      level: "info",
      source: "cgo-ads",
      code: "cgo.ad_action_approved",
      message: "channel ad action approved by cgo (autopilot, ad budget on)",
      tenant_id,
      meta: { decision_class: exec_class },
    });
  } catch {
  }
  return true;
}
