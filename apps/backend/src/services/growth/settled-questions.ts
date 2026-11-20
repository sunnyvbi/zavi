
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { OnYes } from "./cgo-questions";

export const OPEN_ADVICE_TOPIC = "open-advice:";
export const HELD_TOPIC = "held:";
export const HELD_CARD_TOPIC = "held:card:";
const CARD_WAITING_LINE = "The card is waiting for you";
const CENT = 0.005;

export type CardWaiting = { state: "waiting"; hold: boolean } | { state: "done" } | { state: "missing" } | { state: "error" };

export async function readCardWaiting(tenant_id: string, id: string): Promise<CardWaiting> {
  try {
    const db = tenantClient(asTenantId(tenant_id));
    const d = await db.from("decisions").select("status, cgo_hold").eq("tenant_id", tenant_id).eq("id", id).maybeSingle();
    if (d.error) return { state: "error" };
    if (d.data) {
      const r = d.data as { status?: string | null; cgo_hold?: unknown };
      return r.status === "proposed" ? { state: "waiting", hold: r.cgo_hold != null } : { state: "done" };
    }
    const c = await db.from("channel_actions").select("status, exec_status, cgo_hold").eq("tenant_id", tenant_id).eq("id", id).maybeSingle();
    if (c.error) return { state: "error" };
    if (!c.data) return { state: "missing" };
    const r = c.data as { status?: string | null; exec_status?: string | null; cgo_hold?: unknown };
    return r.status === "pending" && r.exec_status == null ? { state: "waiting", hold: r.cgo_hold != null } : { state: "done" };
  } catch {
    return { state: "error" };
  }
}

export type LiveBudget = import("./held-order-yes").LiveBudget;

export type SettledRow = { id: string; topic_key: string; ask: string; on_yes: OnYes | null };

export type SettledDeps = {
  readCard: (tenant_id: string, id: string) => Promise<CardWaiting>;
  readLiveBudget: (tenant_id: string, exec_class: string, object_id: string) => Promise<LiveBudget>;
};

export async function isSettled(tenant_id: string, q: SettledRow, deps: SettledDeps): Promise<boolean> {
  if (q.topic_key.startsWith(OPEN_ADVICE_TOPIC)) return true;
  if (!q.topic_key.startsWith(HELD_TOPIC)) return false;
  if (q.topic_key.startsWith(HELD_CARD_TOPIC)) {
    const id = q.topic_key.slice(HELD_CARD_TOPIC.length);
    if (!id) return false;
    const card = await deps.readCard(tenant_id, id).catch((): CardWaiting => ({ state: "error" }));
    if (card.state === "error") return false;
    return card.state !== "waiting" || card.hold;
  }
  const y = q.on_yes;
  if (y?.kind === "held_ad_order") {
    const live = await deps.readLiveBudget(tenant_id, y.exec_class, y.object_id).catch(() => null);
    if (live === null) return false;
    if ("never" in live) return true;
    return Math.abs(live.usd - y.to_usd) < CENT || Math.abs(live.usd - y.from_usd) >= CENT;
  }
  return y == null && q.ask.includes(CARD_WAITING_LINE);
}

export async function withdrawSettledAdQuestions(tenant_id: string, now: Date, deps?: Partial<SettledDeps>): Promise<number> {
  const d: SettledDeps = {
    readCard: deps?.readCard ?? readCardWaiting,
    readLiveBudget: deps?.readLiveBudget ?? (async (t, c, o) => (await import("./held-order-yes")).readLiveDailyBudget(t, c, o)),
  };
  const db = tenantClient(asTenantId(tenant_id));
  const { data, error } = await db
    .from("cgo_questions")
    .select("id, topic_key, ask, on_yes")
    .eq("tenant_id", tenant_id)
    .in("status", ["open", "queued"])
    .limit(100);
  if (error) throw new Error(`settled-questions: read failed: ${error.message}`);
  let n = 0;
  for (const q of (data ?? []) as SettledRow[]) {
    if (!(await isSettled(tenant_id, q, d))) continue;
    const { data: flipped, error: e } = await db
      .from("cgo_questions")
      .update({ status: "withdrawn" })
      .eq("id", q.id)
      .eq("tenant_id", tenant_id)
      .in("status", ["open", "queued"])
      .select("id");
    if (e) {
      console.warn(`[settled-questions] withdrawing ${q.id} failed: ${e.message}`);
      continue;
    }
    n += ((flipped ?? []) as unknown[]).length;
  }
  if (n > 0) {
    const { promoteQueuedQuietly } = await import("./cgo-questions");
    await promoteQueuedQuietly(tenant_id, now);
  }
  return n;
}

export async function withdrawHeldObjectQuestion(tenant_id: string, topic: string, now: Date): Promise<boolean> {
  try {
    const db = tenantClient(asTenantId(tenant_id));
    const { data, error } = await db
      .from("cgo_questions")
      .update({ status: "withdrawn" })
      .eq("tenant_id", tenant_id)
      .eq("topic_key", topic)
      .in("status", ["open", "queued"])
      .select("id");
    if (error) {
      console.warn(`[settled-questions] withdrawing ${topic} failed: ${error.message}`);
      return false;
    }
    if (((data ?? []) as unknown[]).length > 0) {
      const { promoteQueuedQuietly } = await import("./cgo-questions");
      await promoteQueuedQuietly(tenant_id, now);
    }
    return true;
  } catch (e) {
    console.warn(`[settled-questions] withdrawing ${topic} failed: ${(e as Error).message}`);
    return false;
  }
}
