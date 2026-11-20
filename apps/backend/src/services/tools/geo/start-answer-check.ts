import { z } from "zod";
import { ExpectedToolError, type ToolContext, type ToolSpec } from "@/services/tools/types";
import { isFounderChatOrder } from "@/services/agents/untrusted-context";
import { founderMessageOf, type FounderRunRow } from "@/services/approvals/founder-message";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";
import { realToolEffectDeps, hashToolInput } from "@/services/mcp/tool-effect-ledger";
import { openSweep } from "@/services/tools/growth/geo/visibility/sweep";
import { inngest } from "@/../workers/client";

const inputSchema = z.object({
  country: z.string().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase()).optional(),
}).strict();
const EFFECT_KEY = "geo:start_answer_check";

async function start(ctx: ToolContext & { redo?: boolean }, input: z.infer<typeof inputSchema>) {
  if (!ctx.run_id || ctx.writes_suppressed || ctx.redo || ctx.founder_order_unverified || !isFounderChatOrder(ctx)) {
    throw new ExpectedToolError("founder_request_required", "A verified owner's or admin's chat request is needed to start an AI-answer check. Background, preview and redo runs cannot start one.");
  }
  const { data, error } = await tenantClient(asTenantId(ctx.tenant_id))
    .from("agent_runs").select("id, trigger, enqueued_by, payload")
    .eq("tenant_id", ctx.tenant_id).eq("id", ctx.founder_order_group ?? ctx.run_id).maybeSingle();
  const run = data as FounderRunRow | null;
  if (error || !run) throw new ExpectedToolError("request_unreadable", "I could not verify the original request. No check was started by this call.");
  const message = await founderMessageOf({ ...run, tenant_id: ctx.tenant_id }, { strict: true });
  if (!message?.author_user_id) {
    throw new ExpectedToolError("founder_request_required", "The original human request could not be verified or has expired. Ask to run the AI-answer check again.");
  }
  const lock = await refuseIfChannelPlanLocked(ctx.tenant_id, "geo");
  if (lock) throw new ExpectedToolError("plan_upgrade_required", lock.message, lock.body);

  const root = message.ref.run_id;
  const hash = hashToolInput(input);
  const replay = async () => {
    const stored = await realToolEffectDeps.lookupCommitted(root, EFFECT_KEY);
    if (!stored) return null;
    const result = "result" in stored ? stored.result : stored;
    if ("input_hash" in stored && stored.input_hash !== hash) {
      throw new ExpectedToolError("check_already_requested", "This human request already has an AI-answer check receipt. Read its results; ask in a new message to run another country.");
    }
    return JSON.parse(result.content) as Record<string, unknown>;
  };
  const prior = await replay();
  if (prior) return prior;
  const claimed = await realToolEffectDeps.claimPending({
    run_id: root, tenant_id: ctx.tenant_id, tool_use_id: EFFECT_KEY,
    tool_name: "geo__start_answer_check", input_hash: hash, iter: null, takeover: false,
  });
  if (claimed !== true) {
    const completed = await replay();
    if (completed) return completed;
    throw new ExpectedToolError("check_request_pending", "This request is already being processed or its start receipt is uncertain. Read GEO visibility or open the GEO channel to check progress before requesting another run.");
  }
  const result = await openSweep(ctx.tenant_id, {
    country: input.country ?? null, requestedBy: message.author_user_id,
  }, { send: (event) => inngest.send(event) });
  const receipt = result.ok
    ? { ...result, status: "started", message: "AI-answer check started. This receipt does not say whether it has finished: read GEO visibility for its current status and results, or check the GEO channel. No automatic chat notification is scheduled." }
    : { ...result, status: result.reason === "unavailable" ? "unknown" : "not_started" };
  if (!result.ok && result.reason !== "unavailable") {
    await realToolEffectDeps.release?.(root, EFFECT_KEY);
  } else {
    await realToolEffectDeps.commit(root, EFFECT_KEY, {
      ok: true, is_error: false, content: JSON.stringify(receipt), ms: 0,
    });
  }
  return receipt;
}

export const geoStartAnswerCheckTool: ToolSpec = {
  name: "geo_start_answer_check",
  effect: "money",
  description: "Start one AI-answer visibility check using this workspace's accepted prompts and Zavi's provider budget. Only call when the human asks to run a check, or accepts your specific offer to run it (including 'proceed'). Questions about how checks work, general growth advice, missing results and routine audits are not requests to start. Uses the same plan and usage limits as Run now. Returns a start receipt, not completed results. Read existing results with growth__geo_visibility. No prompts are created or accepted by this tool.",
  input_schema: inputSchema,
  async execute(ctx, raw) {
    const input = inputSchema.parse(raw);
    try {
      return await start(ctx, input);
    } catch (error) {
      if (error instanceof ExpectedToolError) throw error;
      throw new ExpectedToolError("check_start_unconfirmed", "I could not confirm this check's start receipt. Check GEO visibility or the GEO channel before starting another check.");
    }
  },
};
