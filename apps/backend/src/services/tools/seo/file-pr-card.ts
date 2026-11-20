
import { ExpectedToolError } from "@/services/tools/types";
import { recordChannelExecAction } from "@/services/channels/exec-actions";
import { resolveChannelExecEmit } from "@/services/channels/exec-emit";
import type { SitePrPayloadBase, SitePrSpec } from "@/services/channels/site-pr";

type ProposeCtx = {
  tenant_id: string;
  run_id?: string;
  run_trigger?: string;
  writes_suppressed?: boolean;
  redo?: boolean;
  top_action_run?: boolean;
  chat_answer_turn?: boolean;
};

export async function prCardEmitter<P extends SitePrPayloadBase>(
  ctx: unknown,
  spec: SitePrSpec<P>,
  payload: P,
  card: { title: string; body: Record<string, unknown> },
): Promise<{ emit: (decision_class: string, body: unknown) => Promise<string>; kept: () => boolean }> {
  const pctx = ctx as ProposeCtx;
  const notThisChannel = async (): Promise<string> => "";
  let kept = false;
  const emit = await resolveChannelExecEmit(
    new Set([spec.channel]),
    { tenant_id: pctx.tenant_id, run_id: pctx.run_id, run_trigger: pctx.run_trigger, writes_suppressed: pctx.writes_suppressed, redo: pctx.redo, top_action_run: pctx.top_action_run, chat_answer_turn: pctx.chat_answer_turn, emit_decision: notThisChannel },
    async (a) => {
      const out = await recordChannelExecAction({
        tenantId: a.tenant_id,
        runId: a.run_id,
        channelSlug: a.channel_slug,
        execClass: spec.execClass,
        execPayload: payload as unknown as Record<string, unknown>,
        actionType: "fix",
        title: card.title,
        body: card.body,
      });
      kept = out.kept === true;
      return out.id;
    },
  );
  if (!emit || emit === notThisChannel) {
    throw new ExpectedToolError("site_pr_wrong_run", `This pull request card can only be filed from a ${spec.channel.toUpperCase()} channel run. Nothing was written.`);
  }
  return { emit, kept: () => kept };
}

export function prCardResult<P extends SitePrPayloadBase>(
  spec: SitePrSpec<P>,
  payload: P,
  action_id: string,
  kept: boolean,
): Record<string, unknown> {
  if (action_id === "channel_action_suppressed") {
    return { action_id: null, proposed: false, note: "Draft run: nothing was written." };
  }
  return {
    action_id,
    proposed: true,
    repo: payload.repo,
    note: kept
      ? "The founder already has an open card for this same change; it was kept and no new card was written. Do not repeat this fix as a step."
      : `Card written. NOTHING has changed and no pull request is open yet. The founder presses Open pull request on the ${spec.channel.toUpperCase()} channel page to have it opened on ${payload.repo}. Do not repeat this fix as a step.`,
  };
}
