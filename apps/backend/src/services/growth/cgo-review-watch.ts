
import { createHash } from "node:crypto";
import { fleetSweepClient, globalClient } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { alert } from "@/services/logging/alert";
import { isCanonicalContainer } from "@/services/agents/boot-role";

const HOUR = 3_600_000;
export const MISSED_GRACE_HOURS = 26;
const PAGE_LISTED = 5;

export type MissedReview = { tenant_id: string; due_at: string; hours_overdue: number; test: boolean; why: string | null };
export type MissedRow = { tenant_id: string; due_at: string; test: boolean | null; why: string | null };

export type ScanState = { after: string | null; pass_started_at: string; found_count: number; sample: MissedRow[]; digest: string; real_count?: number; real_digest?: string };

const EMPTY_DIGEST = "0000000000000000";
export function foldDigest(digest: string, ids: readonly string[]): string {
  let acc = BigInt(`0x${digest || EMPTY_DIGEST}`);
  for (const id of ids) acc ^= BigInt(`0x${createHash("sha256").update(id).digest("hex").slice(0, 16)}`);
  return acc.toString(16).padStart(16, "0");
}

export type WatchDeps = {
  page: (now: Date, graceHours: number, after: string | null, limit: number) => Promise<Array<MissedRow & { missed: boolean }>>;
  loadState: () => Promise<ScanState | null>;
  saveState: (s: ScanState | null) => Promise<void>;
  slugs?: (ids: string[]) => Promise<Map<string, string>>;
};

export const PAGE = 500;
const PAGE_ATTEMPTS = 3;
export const PASS_MAX_AGE_HOURS = 6;
const STATE_ID = "scan";

function defaultDeps(): WatchDeps {
  const fleet = () => fleetSweepClient("cgo review watch: find Autopilot workspaces whose scheduled review was missed");
  return {
    page: async (now, graceHours, after, limit) => {
      const { data, error } = await fleet().rpc("cgo_missed_reviews", { p_now: now.toISOString(), p_grace_hours: graceHours, p_after: after, p_limit: limit });
      if (error) throw new Error(`cgo-review-watch: cgo_missed_reviews: ${error.message}`);
      return (data ?? []) as Array<MissedRow & { missed: boolean }>;
    },
    loadState: async () => {
      const { data, error } = await globalClient().from("cgo_review_watch_state").select("after, pass_started_at, found_count, sample, digest, real_count, real_digest").eq("id", STATE_ID).maybeSingle();
      if (error) throw new Error(`cgo-review-watch: state read: ${error.message}`);
      return (data as ScanState | null) ?? null;
    },
    saveState: async (st) => {
      const db = globalClient().from("cgo_review_watch_state");
      const { error } = st
        ? await db.upsert({ id: STATE_ID, after: st.after, pass_started_at: st.pass_started_at, found_count: st.found_count, sample: st.sample, digest: st.digest, real_count: st.real_count ?? 0, real_digest: st.real_digest ?? EMPTY_DIGEST, updated_at: new Date().toISOString() }, { onConflict: "id" })
        : await db.delete().eq("id", STATE_ID);
      if (error) throw new Error(`cgo-review-watch: state write: ${error.message}`);
    },
    slugs: async (ids) => {
      const { data, error } = await fleet().from("tenants").select("id, slug").in("id", ids);
      if (error) throw new Error(`cgo-review-watch: slugs: ${error.message}`);
      return new Map(((data ?? []) as Array<{ id: string; slug: string | null }>).filter((t) => t.slug).map((t) => [t.id, t.slug as string]));
    },
  };
}

export type ScanResult = { count: number; sample: MissedReview[]; as_of: Date; digest: string; real_count: number; real_digest: string };

export async function scanMissedRows(now: Date, deps: WatchDeps, onFound: (rows: MissedReview[]) => Promise<void> = async () => undefined): Promise<ScanResult> {
  const saved = await deps.loadState();
  const fresh = saved && now.getTime() - Date.parse(saved.pass_started_at) < PASS_MAX_AGE_HOURS * HOUR;
  let st: ScanState = fresh
    ? { ...saved!, digest: saved!.digest || EMPTY_DIGEST, real_count: saved!.real_count ?? 0, real_digest: saved!.real_digest || EMPTY_DIGEST }
    : { after: null, pass_started_at: now.toISOString(), found_count: 0, sample: [], digest: EMPTY_DIGEST, real_count: 0, real_digest: EMPTY_DIGEST };
  const asOf = new Date(st.pass_started_at);
  for (;;) {
    let rows: Array<MissedRow & { missed: boolean }> | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < PAGE_ATTEMPTS && rows === null; attempt++) {
      try {
        rows = await deps.page(asOf, MISSED_GRACE_HOURS, st.after, PAGE);
      } catch (e) {
        lastError = e;
      }
    }
    if (rows === null) throw lastError instanceof Error ? lastError : new Error(String(lastError));
    const missed = rows.filter((r) => r.missed === true).map(({ tenant_id, due_at, test, why }) => ({ tenant_id, due_at, test, why }));
    if (missed.length) await onFound(toMissed(missed, asOf));
    const real = missed.filter((m) => m.test !== true);
    st = {
      ...st,
      found_count: st.found_count + missed.length,
      sample: liveFirst([...st.sample, ...missed]).slice(0, PAGE_LISTED),
      digest: foldDigest(st.digest, missed.map((m) => m.tenant_id)),
      real_count: (st.real_count ?? 0) + real.length,
      real_digest: foldDigest(st.real_digest ?? EMPTY_DIGEST, real.map((m) => m.tenant_id)),
    };
    if (rows.length < PAGE) {
      await deps.saveState(null);
      return { count: st.found_count, sample: toMissed(st.sample, asOf), as_of: asOf, digest: st.digest, real_count: st.real_count ?? 0, real_digest: st.real_digest ?? EMPTY_DIGEST };
    }
    st = { ...st, after: rows[rows.length - 1].tenant_id };
    await deps.saveState(st);
  }
}

function liveFirst<T extends { test: boolean | null }>(rows: readonly T[]): T[] {
  return [...rows.filter((r) => r.test !== true), ...rows.filter((r) => r.test === true)];
}

export function toMissed(rows: readonly MissedRow[], now: Date): MissedReview[] {
  return rows
    .map((r) => ({ tenant_id: r.tenant_id, due_at: new Date(r.due_at).toISOString(), hours_overdue: Math.floor((now.getTime() - Date.parse(r.due_at)) / HOUR), test: r.test === true, why: r.why ?? null }))
    .sort((a, b) => Number(a.test) - Number(b.test) || a.tenant_id.localeCompare(b.tenant_id));
}

export async function findMissedReviews(now: Date = new Date(), deps: WatchDeps = defaultDeps(), onFound?: (rows: MissedReview[]) => Promise<void>): Promise<ScanResult> {
  return scanMissedRows(now, deps, onFound);
}

export function missedReviewPage(r: Pick<ScanResult, "count" | "real_count" | "sample">, slugs: ReadonlyMap<string, string> = new Map()): string {
  const name = (m: MissedReview) => slugs.get(m.tenant_id) ?? m.tenant_id;
  const item = (m: MissedReview) => `${name(m)} (${m.hours_overdue}h overdue${m.why ? `; last skip ${m.why}` : ""})`;
  const tests = r.count - r.real_count;
  if (r.real_count > 0) {
    const live = r.sample.filter((m) => !m.test);
    const more = r.real_count > live.length ? ` (+${r.real_count - live.length} more)` : "";
    const also = tests > 0 ? ` Also ${tests} test workspace(s), which scheduled reviews skip by design.` : "";
    return `cgo: ${r.real_count} live Autopilot workspace(s) missed a scheduled review by ${MISSED_GRACE_HOURS}h or more, so Autopilot is not reviewing their goals or ad spend: ${live.map(item).join(", ")}${more}.${also}`;
  }
  const listed = r.sample.map((m) => `${name(m)} (${m.hours_overdue}h)`);
  const more = r.count > listed.length ? ` (+${r.count - listed.length} more)` : "";
  return `cgo: ${r.count} test Autopilot workspace(s) are ${MISSED_GRACE_HOURS}h or more past a scheduled review. Scheduled reviews skip test workspaces by design, so this only matters if one should be live (set its tenants.kind to 'real'). Sent once per set: ${listed.join(", ")}${more}.`;
}

export function missedReviewPageKey(r: Pick<ScanResult, "count" | "digest" | "real_count" | "real_digest">, now: Date): string {
  if (r.real_count > 0) return `cgo-review-missed:${now.toISOString().slice(0, 10)}:${r.real_count}:${r.real_digest}`;
  return `cgo-review-missed-test:${r.count}:${r.digest}`;
}

const CLAIM_LEASE_MS = 10 * 60 * 1000;

export type PageClaim = {
  take: (key: string, now: Date) => Promise<boolean>;
  confirm: (key: string) => Promise<void>;
  release: (key: string) => Promise<void>;
};

const localSent = new Set<string>();

export const ledgerClaim: PageClaim = {
  take: async (key, now) => {
    const k = `${key}:fanout`;
    try {
      const db = globalClient();
      const ins = await db
        .from("alert_email_dedup")
        .upsert({ dedupe_key: k, sent_at: now.toISOString(), confirmed_at: null }, { onConflict: "dedupe_key", ignoreDuplicates: true })
        .select("dedupe_key");
      if (ins.error) throw new Error(ins.error.message);
      if ((ins.data ?? []).length > 0) return true;
      const stale = await db
        .from("alert_email_dedup")
        .update({ sent_at: now.toISOString() })
        .eq("dedupe_key", k)
        .is("confirmed_at", null)
        .lt("sent_at", new Date(now.getTime() - CLAIM_LEASE_MS).toISOString())
        .select("dedupe_key");
      if (stale.error) throw new Error(stale.error.message);
      return (stale.data ?? []).length > 0;
    } catch {
      if (localSent.has(k)) return false;
      localSent.add(k);
      return true;
    }
  },
  confirm: async (key) => {
    const { error } = await globalClient().from("alert_email_dedup").update({ confirmed_at: new Date().toISOString() }).eq("dedupe_key", `${key}:fanout`);
    if (error) console.warn(`[cgo-review-watch] page claim confirm failed: ${error.message}`);
  },
  release: async (key) => {
    localSent.delete(`${key}:fanout`);
    const { error } = await globalClient().from("alert_email_dedup").delete().eq("dedupe_key", `${key}:fanout`).is("confirmed_at", null);
    if (error) console.warn(`[cgo-review-watch] page claim release failed: ${error.message}`);
  },
};

async function pageOnce(claim: PageClaim, key: string, now: Date, send: () => Promise<void>): Promise<void> {
  try {
    if (!(await claim.take(key, now))) return;
  } catch {
    return;
  }
  try {
    await send();
    await claim.confirm(key).catch(() => undefined);
  } catch {
    await claim.release(key).catch(() => undefined);
  }
}

export async function probeMissedReviews(
  now: Date = new Date(),
  deps?: WatchDeps,
  send: typeof alert = alert,
  canonical: () => boolean = () => isCanonicalContainer(),
  claim: PageClaim = ledgerClaim,
): Promise<{ missed: number; skipped?: string; failed?: string }> {
  if (!canonical()) return { missed: 0, skipped: "not_canonical" };
  try {
    const d = deps ?? defaultDeps();
    const r = await findMissedReviews(now, d, async (rows) => {
      for (const m of rows) {
        await logEvent({
          level: "warn",
          source: "cgo_review_watch",
          code: "cgo.review_missed",
          tenant_id: m.tenant_id,
          message: "scheduled cgo review missed",
          meta: { count: m.hours_overdue },
        });
      }
    });
    const key = r.count > 0 ? missedReviewPageKey(r, now) : null;
    if (key) {
      await pageOnce(claim, key, now, async () => {
        const slugs = (await d.slugs?.(r.sample.map((m) => m.tenant_id)).catch(() => undefined)) ?? new Map<string, string>();
        await send({ source: "cgo-review-watch", code: "cgo_review_missed", msg: missedReviewPage(r, slugs), email: { dedupeKey: key, required: true } });
      });
    }
    return { missed: r.count };
  } catch (e) {
    const failed = (e as Error).message.slice(0, 200);
    console.warn(`[cgo-review-watch] probe failed: ${failed}`);
    const key = `cgo-review-watch-failed:${now.toISOString().slice(0, 10)}`;
    await pageOnce(claim, key, now, () =>
      send({
        source: "cgo-review-watch",
        code: "cgo_review_watch_failed",
        msg: "cgo review watch could not read its workspace lists, so missed Autopilot reviews are not being detected. See the container log for cgo-review-watch.",
        email: { dedupeKey: key, required: true },
      }),
    );
    return { missed: 0, failed };
  }
}
