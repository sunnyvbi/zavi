import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { RunRow } from "@/services/approvals/approval-envelope";
import { founderMessageOf } from "@/services/approvals/founder-message";
import { carriesCapturedPageContext, isUntrustedContextPayload } from "@/services/agents/untrusted-context";
import { asksForWalletBalance, asksForNewCampaign } from "./wallet-request-intent";
export { asksForWalletBalance } from "./wallet-request-intent";

type WalletRun = RunRow & { id: string; channel_slug?: string };
type ChatPayload = { thread_id?: string; user_message_id?: string };
const PAGE_SIZE = 50;
const MAX_PAGES = 4;

export async function remainingWalletRequest(ctx: { tenant_id: string; run_id?: string }): Promise<boolean> {
  if (!ctx.run_id) return false;
  const db = tenantClient(asTenantId(ctx.tenant_id));
  let id: string | null = ctx.run_id;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const read = await db.from("agent_runs").select("id, trigger, enqueued_by, payload, channel_slug").eq("id", id).maybeSingle();
    if (read.error) throw new Error("Wallet request run could not be verified");
    if (!read.data) return false;
    const run = { ...read.data, id } as WalletRun;
    if (seen.size === 1 && run.channel_slug !== "chatgpt_ads") return false;
    if (run.trigger === "chat") return chatWalletRequest(ctx.tenant_id, run);
    if (run.trigger !== "handoff" && run.trigger !== "a2a") return false;
    const edge: { data: unknown; error: unknown } = await db.from("delegation_lineage").select("parent_run_id").eq("child_run_id", id).maybeSingle();
    if (edge.error) throw new Error("Wallet request ancestry could not be verified");
    id = (edge.data as { parent_run_id?: string } | null)?.parent_run_id ?? null;
  }
  return false;
}

async function chatWalletRequest(tenantId: string, run: WalletRun): Promise<boolean> {
  const db = tenantClient(asTenantId(tenantId));
  const text = (await founderMessageOf({ ...run, tenant_id: tenantId }, { strict: true, anyAge: true }))?.text;
  if (!text) return false;
  if (asksForWalletBalance(text)) return true;
  if (asksForNewCampaign(text)) return false;
  const payload = run.payload as ChatPayload | null;
  if (!payload?.thread_id || !payload.user_message_id) return false;
  const current = await db.from("agent_thread_messages").select("created_at")
    .eq("id", payload.user_message_id).eq("thread_id", payload.thread_id).maybeSingle();
  if (current.error) throw new Error("Wallet request context could not be verified");
  const currentAt = (current.data as { created_at?: unknown } | null)?.created_at;
  if (typeof currentAt !== "string" || !Number.isFinite(Date.parse(currentAt))) return false;

  for (let offset = 0; offset < MAX_PAGES * PAGE_SIZE; offset += PAGE_SIZE) {
    const prior = await db.from("agent_thread_messages").select("id, agent_run_id, body, created_at")
      .eq("thread_id", payload.thread_id).eq("sender_role", "user")
      .lt("created_at", currentAt).order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (prior.error) throw new Error("Wallet request context could not be verified");
    const messages = (prior.data ?? []) as { id: string; agent_run_id: string | null; body: unknown; created_at: string }[];
    if (!messages.length) return false;
    const ids = messages.flatMap(m => typeof m.agent_run_id === "string" ? [m.agent_run_id] : []);
    const runs = new Map<string, WalletRun>();
    if (ids.length) {
      const parents = await db.from("agent_runs").select("id, trigger, enqueued_by, payload, channel_slug").in("id", ids);
      if (parents.error) throw new Error("Wallet request context could not be verified");
      for (const r of (parents.data ?? []) as WalletRun[]) runs.set(r.id, r);
    }
    for (const message of messages) {
      if (!asksForWalletBalance(message.body) && !asksForNewCampaign(message.body)) continue;
      const previous = message.agent_run_id ? runs.get(message.agent_run_id) : null;
      const previousPayload = previous?.payload as ChatPayload | null;
      if (!previous || previous.trigger !== "chat" || previous.enqueued_by !== run.enqueued_by
        || previous.channel_slug !== run.channel_slug || previousPayload?.thread_id !== payload.thread_id
        || previousPayload?.user_message_id !== message.id
        || isUntrustedContextPayload(previous.payload) || carriesCapturedPageContext(previous.payload)) continue;
      const own = (await founderMessageOf({ ...previous, tenant_id: tenantId }, { strict: true, anyAge: true }))?.text;
      if (!own) continue;
      if (asksForWalletBalance(own)) return true;
      if (asksForNewCampaign(own)) return false;
    }
    if (messages.length < PAGE_SIZE) return false;
  }
  return false;
}
