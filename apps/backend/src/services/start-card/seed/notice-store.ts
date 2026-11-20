import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { globalClient, startCardRpc } from "@/services/tenant-client";
import { safeFetchText } from "@/services/onboarding/enrichment/discover";
import { isPrivateIp } from "@/services/onboarding/enrichment/url-guard";
import type { ClaimOutcome } from "./notices";

type Source = "yc" | "product_hunt";

export async function doneItems(runId: string, after: string, limit: number): Promise<Array<{ domain: string; card_id: string; source: Source }>> {
  const { data, error } = await globalClient()
    .from("seed_run_items")
    .select("domain, card_id, source")
    .eq("run_id", runId)
    .eq("state", "done")
    .is("contact_checked_at", null)
    .not("card_id", "is", null)
    .gt("domain", after)
    .order("domain")
    .limit(limit);
  if (error) throw new Error(`seed items read failed: ${error.message}`);
  return (data ?? []) as Array<{ domain: string; card_id: string; source: Source }>;
}

export async function markChecked(runId: string, domain: string): Promise<void> {
  const { error } = await globalClient()
    .from("seed_run_items")
    .update({ contact_checked_at: new Date().toISOString() })
    .eq("run_id", runId)
    .eq("domain", domain);
  if (error) throw new Error(`seed item update failed: ${error.message}`);
}

export async function hasNotice(domain: string): Promise<boolean> {
  const { data, error } = await globalClient().from("seed_notices").select("domain").eq("domain", domain).maybeSingle();
  if (error) throw new Error(`seed notice read failed: ${error.message}`);
  return Boolean(data);
}

export async function insertNotice(row: { domain: string; card_id: string; email: string; idempotency_key: string }): Promise<"inserted" | "exists"> {
  const { error } = await globalClient().from("seed_notices").insert(row);
  if (!error) return "inserted";
  if (error.code === "23505") return "exists";
  throw new Error(`seed notice insert failed: ${error.message}`);
}

export async function pendingNotices(limit: number): Promise<Array<{ domain: string; source: Source | null }>> {
  if (limit <= 0) return [];
  const { data, error } = await globalClient()
    .from("seed_notices")
    .select("domain, card_id")
    .eq("state", "pending")
    .order("created_at")
    .limit(limit);
  if (error) throw new Error(`seed notices read failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ domain: string; card_id: string | null }>;
  const cards = rows.map((r) => r.card_id).filter((c): c is string => Boolean(c));
  const src = new Map<string, Source>();
  if (cards.length > 0) {
    const { data: items, error: e2 } = await globalClient().from("seed_run_items").select("card_id, source").in("card_id", cards);
    if (e2) throw new Error(`seed items read failed: ${e2.message}`);
    for (const i of (items ?? []) as Array<{ card_id: string; source: Source }>) src.set(i.card_id, i.source);
  }
  return rows.map((r) => ({ domain: r.domain, source: (r.card_id && src.get(r.card_id)) || null }));
}

export async function claimedToday(now: Date = new Date()): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const { count, error } = await globalClient().from("seed_notices").select("domain", { count: "exact", head: true }).gte("claimed_at", start);
  if (error) throw new Error(`seed notices count failed: ${error.message}`);
  return count ?? 0;
}

export async function claimNotice(domain: string, perDay: number): Promise<ClaimOutcome> {
  const { data, error } = await startCardRpc("seed_notice_claim_capped", { p_domain: domain, p_per_day: perDay });
  if (error) throw new Error(`seed notice claim failed: ${error.message}`);
  const o = data as { outcome?: string; email?: string; idempotency_key?: string; card_id?: string } | null;
  if (o?.outcome === "claimed" && o.email && o.idempotency_key && o.card_id) {
    return { outcome: "claimed", email: o.email, idempotency_key: o.idempotency_key, card_id: o.card_id };
  }
  if (o?.outcome === "no_notice" || o?.outcome === "not_pending" || o?.outcome === "cancelled" || o?.outcome === "day_cap") {
    return { outcome: o.outcome };
  }
  throw new Error(`seed notice claim returned ${String(o?.outcome)}`);
}

export async function noticeAccepted(domain: string, messageId: string): Promise<string> {
  const { data, error } = await startCardRpc("seed_notice_accepted", { p_domain: domain, p_provider_message_id: messageId });
  if (error) throw new Error(`seed notice record failed: ${error.message}`);
  return String((data as { outcome?: string } | null)?.outcome ?? "unknown");
}

export async function markNoticeFailed(domain: string, state: "unknown" | "bounced", err: string): Promise<void> {
  const { error } = await globalClient()
    .from("seed_notices")
    .update({ state, error: err.slice(0, 300), updated_at: new Date().toISOString() })
    .eq("domain", domain)
    .eq("state", "claimed");
  if (error) throw new Error(`seed notice update failed: ${error.message}`);
}

export async function releaseNotice(domain: string, err: string): Promise<void> {
  const { error } = await globalClient()
    .from("seed_notices")
    .update({ state: "pending", claimed_at: null, error: err.slice(0, 300), updated_at: new Date().toISOString() })
    .eq("domain", domain)
    .eq("state", "claimed");
  if (error) throw new Error(`seed notice update failed: ${error.message}`);
}

export async function stuckNotices(
  olderThanMs = 10 * 60_000,
): Promise<Array<{ domain: string; state: string; claimed_at: string | null; error: string | null; idempotency_key: string }>> {
  const before = new Date(Date.now() - olderThanMs).toISOString();
  const { data, error } = await globalClient()
    .from("seed_notices")
    .select("domain, state, claimed_at, error, idempotency_key")
    .or(`state.eq.unknown,and(state.eq.claimed,claimed_at.lt.${before})`)
    .order("claimed_at")
    .limit(500);
  if (error) throw new Error(`seed notices read failed: ${error.message}`);
  return (data ?? []) as Array<{ domain: string; state: string; claimed_at: string | null; error: string | null; idempotency_key: string }>;
}

export async function recordConfirmedSend(domain: string, messageId: string): Promise<string> {
  const { error } = await globalClient()
    .from("seed_notices")
    .update({ state: "claimed", updated_at: new Date().toISOString() })
    .eq("domain", domain)
    .in("state", ["unknown", "claimed"]);
  if (error) throw new Error(`seed notice update failed: ${error.message}`);
  return noticeAccepted(domain, messageId);
}

export async function unsubscribeByKey(key: string): Promise<"removed" | "unknown"> {
  const { data, error } = await startCardRpc("seed_notice_unsubscribe", { p_key: key });
  if (error) throw new Error(`seed notice unsubscribe failed: ${error.message}`);
  return (data as { outcome?: string } | null)?.outcome === "removed" ? "removed" : "unknown";
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

export function guardedLookup(hostname: string, options: { all?: boolean }, cb: LookupCb, lookup = dnsLookup): void {
  lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err, "");
    const list = addrs as LookupAddress[];
    if (list.length === 0 || list.some((a) => isPrivateIp(a.address))) {
      return cb(Object.assign(new Error("ssrf_blocked"), { code: "ESSRF" }), "");
    }
    if (options?.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

function headerObject(h: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export const guardedFetch = ((url: string, init?: RequestInit) =>
  new Promise<Response>((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.request(
      u,
      {
        method: "GET",
        headers: headerObject(init?.headers),
        lookup: ((h: string, o: { all?: boolean }, cb: LookupCb) => guardedLookup(h, o, cb)) as never,
        signal: init?.signal ?? undefined,
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
        const status = res.statusCode ?? 502;
        if (status < 200 || status >= 300) {
          res.destroy();
          resolve(new Response(null, { status: status < 200 ? 502 : status, headers }));
          return;
        }
        if (status === 204) {
          res.destroy();
          resolve(new Response(null, { status, headers }));
          return;
        }
        resolve(new Response(Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>, { status, headers }));
      },
    );
    req.on("error", reject);
    req.end();
  })) as unknown as typeof fetch;

export const fetchSiteText = (url: string, domain: string) =>
  safeFetchText(url, domain, Date.now() + 15_000, 1_500_000, undefined, guardedFetch);
