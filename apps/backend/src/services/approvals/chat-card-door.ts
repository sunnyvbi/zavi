
import type { attachCardToChat as AttachFn } from "./chat-card-attach";
import type { handOffChatCardDelivery as HandOffFn } from "./chat-card-delivery";
import type { cgoApproveAdDecision as CgoApproveFn } from "@/services/growth/cgo-ads";

export type CardAroundDoorInput = {
  tenant_id: string;
  run_id: string;
  trigger: string | null | undefined;
  has_thread: boolean;
  decision_id: string;
  decision_class: string;
  body: unknown;
  agent_slug: string;
  prior_handoff?: import("./chat-card-delivery").HandOffOutcome | null;
  reused?: boolean;
};

export type CardAroundDoorDeps = {
  cgoApprove: typeof CgoApproveFn;
  attach: typeof AttachFn;
  handOff: typeof HandOffFn;
};

async function defaultDeps(): Promise<CardAroundDoorDeps> {
  const [{ cgoApproveAdDecision }, { attachCardToChat }, { handOffChatCardDelivery }] = await Promise.all([
    import("@/services/growth/cgo-ads"),
    import("./chat-card-attach"),
    import("./chat-card-delivery"),
  ]);
  return { cgoApprove: cgoApproveAdDecision, attach: attachCardToChat, handOff: handOffChatCardDelivery };
}

const META_OR_GOOGLE = /^(meta_ads|google_ads)\./;

export async function decisionsFiledByRun(tenant_id: string, run_id: string): Promise<Set<string> | null> {
  try {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("decisions")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("agent_run_id", run_id)
      .limit(1000);
    if (error) return null;
    const rows = (data ?? []) as Array<{ id: string }>;
    if (rows.length >= 1000) return null;
    return new Set(rows.map((r) => r.id));
  } catch {
    return null;
  }
}

export async function filedByThisRun(tenant_id: string, decision_id: string, run_id: string, before: Set<string> | null): Promise<boolean> {
  if (!before || before.has(decision_id)) return false;
  try {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("decisions")
      .select("agent_run_id, cgo_hold")
      .eq("id", decision_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (error || !data) return false;
    const r = data as { agent_run_id?: unknown; cgo_hold?: unknown };
    return r.agent_run_id === run_id && r.cgo_hold == null;
  } catch {
    return false;
  }
}

export function takesCgoDoor(decision_class: string): boolean {
  return META_OR_GOOGLE.test(decision_class) || decision_class === "linkedin_ads.launch_campaign";
}

export async function cardAroundCgoDoor(input: CardAroundDoorInput, injected?: Partial<CardAroundDoorDeps>): Promise<{ cgoApproved: boolean; cardInChat: boolean }> {
  const d = { ...(await defaultDeps()), ...(injected ?? {}) };
  const metaOrGoogle = META_OR_GOOGLE.test(input.decision_class);
  const chatTurn = input.trigger === "chat" && input.has_thread;
  let cardInChat = false;
  let covered = input.prior_handoff === "queued" || input.prior_handoff === "told";
  let tried = false;
  const showInChat = async (): Promise<boolean> => {
    if (cardInChat || covered) return true;
    if (!chatTurn || !metaOrGoogle || tried) return false;
    tried = true;
    try {
      const r = await d.attach({ tenant_id: input.tenant_id, run_id: input.run_id, card_id: input.decision_id, table: "decisions" });
      cardInChat = r.shown;
    } catch (e) {
      const outcome = await d.handOff({ tenant_id: input.tenant_id, run_id: input.run_id, card_id: input.decision_id, decision_class: input.decision_class, error: (e as Error).message });
      covered = outcome === "queued" || outcome === "told";
    }
    return cardInChat || covered;
  };
  let cgoApproved = false;
  if (takesCgoDoor(input.decision_class) && input.reused !== true) {
    try {
      cgoApproved = await d.cgoApprove(input.tenant_id, input.decision_id, input.decision_class, input.body, input.agent_slug, metaOrGoogle && chatTurn ? { shownInChat: showInChat } : {});
    } catch {
      cgoApproved = false;
    }
  }
  if (!cgoApproved) await showInChat();
  return { cgoApproved, cardInChat };
}
