import { isComposioDecisionClass, COMPOSIO_EXECUTE_HANDLER } from "@/services/connectors/composio/write-classify";
import { metaActionRaisesSpend } from "@/services/tools/meta-ads/write/_decision-bodies";
import { tiktokActionRaisesSpend } from "@/services/connectors/tiktok-ads/held-schema";
import { chatgptActionRaisesSpend } from "@/services/connectors/chatgpt-ads/raises-spend";

type Maybe<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>;
type ReadChain = {
  select: (cols: string) => ReadChain;
  eq: (col: string, v: unknown) => ReadChain;
  maybeSingle: () => Maybe<{ decision_class: string | null; handler: string | null; body?: unknown }>;
};

export type ChatQuickApproveResult =
  | { ok: true }
  | { ok: false; code: "composio_needs_card" | "spend_needs_card" | "decision_lookup_failed" | "approve_failed"; message: string };

export const COMPOSIO_CHAT_APPROVE_REFUSAL =
  "This action changes something in a connected app. Approve it from its card in this chat, where every field it will send is shown.";

export const SPEND_CHAT_APPROVE_REFUSAL =
  "This change can raise ad spend. Approve it from its card, where an owner or admin can approve it.";

export async function approveFromChatQuickPath(args: {
  svc: { from: (t: string) => unknown };
  userClient: { rpc: (fn: string, params: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }> };
  decision_id: string;
  tenant_id: string;
}): Promise<ChatQuickApproveResult> {
  const { data, error } = await (args.svc.from("decisions") as ReadChain)
    .select("decision_class, handler, body")
    .eq("id", args.decision_id)
    .eq("tenant_id", args.tenant_id)
    .maybeSingle();
  if (error || !data) {
    return { ok: false, code: "decision_lookup_failed", message: error?.message ?? "decision not found" };
  }
  if (isComposioDecisionClass(data.decision_class) || data.handler === COMPOSIO_EXECUTE_HANDLER) {
    return { ok: false, code: "composio_needs_card", message: COMPOSIO_CHAT_APPROVE_REFUSAL };
  }
  const cls = data.decision_class;
  if (
    (cls?.startsWith("meta_ads.") && metaActionRaisesSpend(cls, data.body)) ||
    tiktokActionRaisesSpend(cls, data.body) ||
    chatgptActionRaisesSpend(cls, data.body) ||
    cls === "linkedin_ads.launch_campaign"
  ) {
    return { ok: false, code: "spend_needs_card", message: SPEND_CHAT_APPROVE_REFUSAL };
  }
  const { error: rpcErr } = await args.userClient.rpc("approve_decision", { p_decision_id: args.decision_id });
  if (rpcErr) return { ok: false, code: "approve_failed", message: rpcErr.message };
  return { ok: true };
}
