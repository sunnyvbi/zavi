import { ExpectedToolError, type ToolContext } from "@/services/tools/types";
import { resolveChannelExecEmit } from "@/services/channels/exec-emit";
import { isChatAnswerTurnEmit } from "@/services/agents/redo-mode";
import { loadBookableCreator, type BookableCreator } from "@/services/creators/booking-db";
import { creatorPayoutCountrySupported } from "@/services/creators/payout-countries";
import { computeCreatorFees, type CreatorFeeBreakdown } from "@/services/creators/order-fees";
import { latestCreatorCaps } from "@/services/decisions/creator-hire-budget";
import { platformWriteEnabled } from "@/services/channels/exec-kill-switch";
import { asTenantId, globalClient, tenantClient } from "@/services/tenant-client";

export const CREATOR_TOOL_CHANNELS: ReadonlySet<string> = new Set(["ugc"]);

export type CreatorToolCtx = ToolContext & { redo?: boolean };

export type CreatorChannelOutcome<T> = { suppressed: true } | { suppressed: false; result: T };

export async function onCreatorChannel<T>(
  ctx: ToolContext,
  execClass: string,
  wrongRunCode: string,
  work: (a: { tenant_id: string; run_id: string; channel_slug: string }) => Promise<T>,
): Promise<CreatorChannelOutcome<T>> {
  if (!(await platformWriteEnabled("creator.hire"))) {
    throw new ExpectedToolError(
      "creator_hires_off",
      "Creator hiring is switched off on Zavi right now. Nothing was sent or written. Do not retry this run; tell the founder creator hiring is paused.",
    );
  }
  const c = ctx as CreatorToolCtx;
  const notThisChannel = async (): Promise<string> => "";
  let result: { value: T } | null = null;
  const emit = await resolveChannelExecEmit(
    CREATOR_TOOL_CHANNELS,
    {
      tenant_id: c.tenant_id,
      run_id: c.run_id,
      run_trigger: c.run_trigger,
      writes_suppressed: c.writes_suppressed,
      redo: c.redo,
      top_action_run: c.top_action_run,
      chat_answer_turn: isChatAnswerTurnEmit(c.emit_decision),
      emit_decision: notThisChannel,
    },
    async (a) => {
      result = { value: await work({ tenant_id: a.tenant_id, run_id: a.run_id, channel_slug: a.channel_slug }) };
      return "done";
    },
  );
  if (!emit || emit === notThisChannel) {
    throw new ExpectedToolError(
      wrongRunCode,
      "Creator hiring tools only work on a UGC Videos channel run. Nothing was written.",
    );
  }
  const out = await emit(execClass, {});
  if (out === "channel_action_suppressed") return { suppressed: true };
  if (!result) throw new Error(`${execClass}: the run wrote nothing`);
  return { suppressed: false, result: (result as { value: T }).value };
}

export async function loadHireableCreator(human_member_id: string): Promise<BookableCreator> {
  const creator = await loadBookableCreator(human_member_id);
  if (!creator || creator.vetting_state !== "approved" || !creatorPayoutCountrySupported(creator.country_code)) {
    throw new ExpectedToolError(
      "creator_not_hireable",
      "That creator is not an approved, bookable creator on Zavi. Use a human_member_id from growth__search_human_members with bookable=true. Nothing was sent.",
    );
  }
  return creator;
}

export function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function assertWithinHireCap(tenant_id: string, price_cents: number): Promise<CreatorFeeBreakdown> {
  const fees = computeCreatorFees(price_cents);
  const caps = await latestCreatorCaps(tenant_id);
  if (!caps) {
    throw new ExpectedToolError(
      "creator_no_caps",
      "No creator hiring caps are set for this business yet, so no hire can be proposed. Nothing was created. The CGO sets the per-hire and weekly caps first.",
    );
  }
  if (fees.business_total_cents > Math.round(caps.per_hire_usd * 100)) {
    throw new ExpectedToolError(
      "creator_over_hire_cap",
      `This hire comes to ${usd(fees.business_total_cents)} with the Zavi fee, over the ${usd(Math.round(caps.per_hire_usd * 100))} per-hire cap. Nothing was created. Pick a cheaper package or a lower price.`,
    );
  }
  return fees;
}

export const CREATOR_OUTREACH_DAILY_CAP = 20;

async function outreachDailyCap(): Promise<number> {
  const { data, error } = await globalClient().from("system_config").select("blob").eq("id", 1).maybeSingle();
  if (error) throw new Error(`system_config read failed: ${error.message}`);
  const v = ((data?.blob ?? {}) as Record<string, unknown>).creator_outreach_daily_cap;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : CREATOR_OUTREACH_DAILY_CAP;
}

export async function assertWithinOutreachCap(tenant_id: string, now: Date = new Date()): Promise<void> {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const client = tenantClient(asTenantId(tenant_id));
  const [cap, messages, offers] = await Promise.all([
    outreachDailyCap(),
    client
      .from("creator_thread_messages")
      .select("id", { count: "exact", head: true })
      .eq("sender_kind", "tenant")
      .is("sender_user_id", null)
      .gte("created_at", since),
    client
      .from("creator_offers")
      .select("id", { count: "exact", head: true })
      .not("agent_run_id", "is", null)
      .gte("created_at", since),
  ]);
  if (messages.error) throw new Error(`creator_thread_messages count failed: ${messages.error.message}`);
  if (offers.error) throw new Error(`creator_offers count failed: ${offers.error.message}`);
  if ((messages.count ?? 0) + (offers.count ?? 0) >= cap) {
    throw new ExpectedToolError(
      "creator_outreach_daily_cap",
      `Daily limit of ${cap} creator messages and offers reached; try again tomorrow. Nothing was sent.`,
    );
  }
}
