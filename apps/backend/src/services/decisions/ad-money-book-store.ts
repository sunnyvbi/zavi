
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { LAUNCH_GRACE_MS, OBSERVED_DAYS } from "@/services/growth/delivery-capacity";
import { parseMonthView, readAdBudgetMonthView } from "./ad-budget";
import {
  advanceMemory,
  compareShadowVerdicts,
  monthSnapshot,
  objectCounts,
  shadowVerdict,
  type BookAccount,
  type BookChange,
  type BookHold,
  type BookObject,
  type BookSpend,
  type MonthSnapshot,
  type RealAnswer,
  type ShadowChange,
  type ShadowComparison,
  type ShadowContext,
  type ShadowVerdictRow,
  type SnapshotInput,
} from "./ad-money-book";

const DAY_MS = 86_400_000;
export const BOOK_PAGE = 1000;
export const BOOK_MAX_PAGES = 100;
const ID_CHUNK = 100;
export const SHADOW_READ_TIMEOUT_MS = 2000;

type PageAnswer = { data: unknown; error: { message: string } | null };

export async function readAllPages<T>(what: string, page: (from: number, to: number) => PromiseLike<PageAnswer>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; ; p++) {
    if (p >= BOOK_MAX_PAGES) throw new Error(`${what} is larger than one snapshot covers`);
    const { data, error } = await page(p * BOOK_PAGE, (p + 1) * BOOK_PAGE - 1);
    if (error) throw new Error(`${what} read failed: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < BOOK_PAGE) break;
  }
  return out;
}

type SpendRow = BookSpend & { source?: string | null };

export async function loadSnapshotInput(a: {
  tenant_id: string;
  budget: SnapshotInput["budget"];
  accounts: readonly BookAccount[];
  unread_platforms: readonly string[];
  read_started_at: Date;
  now: Date;
}): Promise<SnapshotInput> {
  const db = tenantClient(asTenantId(a.tenant_id));
  const platforms = [...new Set([...a.accounts.map((x) => x.platform), ...a.unread_platforms])];
  const base = { budget: a.budget, accounts: a.accounts, unread_platforms: a.unread_platforms, read_started_at: a.read_started_at.toISOString(), now: a.now };
  const since = new Date(Date.UTC(a.now.getUTCFullYear(), a.now.getUTCMonth(), a.now.getUTCDate()) - (OBSERVED_DAYS + 1) * DAY_MS).toISOString().slice(0, 10);

  const holds = await readAllPages<BookHold>("ad_budget_reservations", (from, to) =>
    db
      .from("ad_budget_reservations")
      .select("id, idem_key, platform, object_id, status, paused, daily_delta_usd, created_at, updated_at")
      .eq("budget_id", a.budget.budget_id)
      .in("status", ["reserved", "committed"])
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (platforms.length === 0) return { ...base, objects: [], spend: [], lifetime_spend: {}, changes: [], holds };

  const objects = await readAllPages<BookObject>("ad_campaigns", (from, to) =>
    db
      .from("ad_campaigns")
      .select("platform, account_id, object_id, level, campaign_id, name, budget_kind, budget_usd, campaign_budget_usd, status")
      .in("platform", platforms)
      .order("id", { ascending: true })
      .range(from, to),
  );
  const spend = await readAllPages<SpendRow>("ad_spend_daily", (from, to) =>
    db
      .from("ad_spend_daily")
      .select("platform, account_id, object_id, spend_date, amount_usd")
      .in("platform", platforms)
      .gte("spend_date", since)
      .order("id", { ascending: true })
      .range(from, to),
  );
  const changes = await readAllPages<BookChange>("ad_object_changes", (from, to) =>
    db
      .from("ad_object_changes")
      .select("platform, object_id, campaign_id, occurred_at")
      .gte("occurred_at", new Date(a.now.getTime() - LAUNCH_GRACE_MS).toISOString())
      .order("id", { ascending: true })
      .range(from, to),
  );

  const unread = new Set(a.unread_platforms);
  const read = new Set(a.accounts.map((x) => `${x.platform}:${x.account_id}`));
  const counted = objects.filter((o) => unread.has(o.platform) || read.has(`${o.platform}:${o.account_id}`));
  const lifetimeCampaigns = new Set(
    counted
      .filter((o) => o.budget_kind === "lifetime" && Number(o.budget_usd) > 0 && objectCounts(o).counts)
      .map((o) => `${o.platform}:${o.account_id}:${o.campaign_id || o.object_id}`),
  );
  const wanted = new Set(
    counted.filter((o) => lifetimeCampaigns.has(`${o.platform}:${o.account_id}:${o.campaign_id || o.object_id}`)).map((o) => `${o.platform}:${o.account_id}:${o.object_id}`),
  );
  const ids = [...new Set(counted.filter((o) => wanted.has(`${o.platform}:${o.account_id}:${o.object_id}`)).map((o) => o.object_id))];
  const perDay = new Map<string, number>();
  for (let k = 0; k < ids.length; k += ID_CHUNK) {
    const chunk = ids.slice(k, k + ID_CHUNK);
    const rows = await readAllPages<SpendRow>("ad_spend_daily (lifetime budgets)", (from, to) =>
      db
        .from("ad_spend_daily")
        .select("platform, account_id, object_id, spend_date, amount_usd")
        .in("platform", platforms)
        .in("object_id", chunk)
        .order("id", { ascending: true })
        .range(from, to),
    );
    for (const r of rows) {
      const key = `${r.platform}:${r.account_id}:${r.object_id}`;
      if (!wanted.has(key)) continue;
      const dayKey = `${key}|${String(r.spend_date).slice(0, 10)}`;
      perDay.set(dayKey, Math.max(perDay.get(dayKey) ?? 0, Math.max(0, Number(r.amount_usd) || 0)));
    }
  }
  const cents = new Map<string, number>();
  for (const [dayKey, amount] of perDay) {
    const key = dayKey.slice(0, dayKey.lastIndexOf("|"));
    cents.set(key, (cents.get(key) ?? 0) + Math.round(amount * 100));
  }
  const lifetime_spend: Record<string, number> = {};
  for (const [key, c] of cents) lifetime_spend[key] = c / 100;

  return { ...base, objects, spend, lifetime_spend, changes, holds };
}

export type StoreSnapshotOutcome =
  | { status: "skipped"; reason: string }
  | { status: "stored" | "stale"; generation: number | null; snapshot: MonthSnapshot };

export async function storeMonthSnapshot(a: {
  tenant_id: string;
  budget_id: string;
  accounts: readonly BookAccount[];
  unread_platforms: readonly string[];
  read_started_at: Date;
  now: Date;
}): Promise<StoreSnapshotOutcome> {
  const view = await readAdBudgetMonthView(a.tenant_id);
  if (!view || view.status !== "active") return { status: "skipped", reason: "no_active_budget" };
  if (view.id !== a.budget_id) return { status: "skipped", reason: "other_budget" };
  const input = await loadSnapshotInput({
    tenant_id: a.tenant_id,
    budget: {
      budget_id: view.id,
      month_start: view.month_start,
      month_cap_usd: view.month_cap_usd,
      spent_usd: view.spent_usd,
      creator_held_usd: view.creator_held_usd,
      creator_spent_usd: view.creator_spent_usd,
      days_left: view.days_left,
      margin: view.margin ?? 1,
    },
    accounts: a.accounts,
    unread_platforms: a.unread_platforms,
    read_started_at: a.read_started_at,
    now: a.now,
  });
  const last = await tenantClient(asTenantId(a.tenant_id)).from("ad_budget_snapshots").select("memory").eq("budget_id", view.id).maybeSingle();
  if (last.error) throw new Error(`ad_budget_snapshots read failed: ${last.error.message}`);
  const { memory, changes } = advanceMemory((last.data as { memory?: unknown } | null)?.memory ?? null, {
    objects: input.objects,
    accounts: a.accounts,
    unread_platforms: a.unread_platforms,
    now: a.now,
  });
  const snapshot = monthSnapshot({ ...input, changes: [...input.changes, ...changes] });
  const r = await tenantRpc(asTenantId(a.tenant_id), "record_ad_budget_snapshot", {
    p_budget_id: snapshot.budget_id,
    p_month_start: snapshot.month_start,
    p_read_started_at: snapshot.read_started_at,
    p_totals: snapshot.totals,
    p_objects: snapshot.objects,
    p_complete_platforms: snapshot.complete_platforms,
    p_unread_platforms: snapshot.unread_platforms,
    p_reflected_hold_ids: snapshot.reflected_hold_ids,
    p_memory: memory,
  });
  if (r.error) throw new Error(`record_ad_budget_snapshot failed: ${r.error.message}`);
  const ans = (r.data ?? {}) as { status?: string; generation?: number | string | null };
  if (ans.status !== "stored" && ans.status !== "stale") throw new Error("record_ad_budget_snapshot returned an unknown answer");
  const generation = ans.generation == null ? null : Number(ans.generation);
  return { status: ans.status, generation, snapshot: { ...snapshot, generation } };
}

function parseShadowContext(raw: unknown): ShadowContext {
  const r = (raw ?? {}) as Record<string, unknown>;
  const view = parseMonthView(r.view ?? null);
  const s = (r.snapshot ?? null) as Record<string, unknown> | null;
  return {
    view,
    snapshot:
      s && typeof s.budget_id === "string"
        ? {
            budget_id: s.budget_id,
            month_start: String(s.month_start ?? ""),
            generation: s.generation == null ? null : Number(s.generation),
            read_started_at: String(s.read_started_at ?? ""),
            totals: (s.totals && typeof s.totals === "object" ? s.totals : null) as NonNullable<ShadowContext["snapshot"]>["totals"],
            reflected_hold_ids: Array.isArray(s.reflected_hold_ids) ? (s.reflected_hold_ids as string[]) : [],
          }
        : null,
    open_holds: Array.isArray(r.open_holds) ? (r.open_holds as BookHold[]) : [],
    open_holds_truncated: r.open_holds_truncated === true,
  };
}

export async function recordShadowVerdict(i: {
  tenant_id: string;
  change: ShadowChange;
  real: RealAnswer;
  now?: Date;
}): Promise<{ row: ShadowVerdictRow | null; written: Promise<void> }> {
  const tid = asTenantId(i.tenant_id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let answer: PageAnswer;
  try {
    answer = await Promise.race([
      Promise.resolve(tenantRpc(tid, "ad_budget_shadow_context", {}) as unknown as PromiseLike<PageAnswer>),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("ad_budget_shadow_context timed out")), SHADOW_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (answer.error) throw new Error(`ad_budget_shadow_context failed: ${answer.error.message}`);
  const row = shadowVerdict(parseShadowContext(answer.data), i.change, i.real, i.now ?? new Date());
  if (!row) return { row: null, written: Promise.resolve() };
  const written = (async () => {
    try {
      const w = await tenantRpc(tid, "record_ad_budget_shadow_verdict", { p_row: row });
      if (w.error) throw new Error(w.error.message);
    } catch (e) {
      console.warn(`[ad-money-book] shadow verdict for ${row.idem_key} not stored (tenant ${i.tenant_id}): ${(e as Error).message}`);
    }
  })();
  return { row, written };
}

export async function readShadowComparison(tenant_id: string, since: Date): Promise<ShadowComparison> {
  const db = tenantClient(asTenantId(tenant_id));
  const rows = await readAllPages<ShadowVerdictRow & { created_at: string }>("ad_budget_shadow_verdicts", (from, to) =>
    db
      .from("ad_budget_shadow_verdicts")
      .select(
        "budget_id, idem_key, platform, op, object_id, daily_delta_usd, real_verdict, real_reason, real_amount_usd, real_room_usd, " +
          "shadow_verdict, shadow_note, shadow_change_usd, shadow_open_auth_usd, shadow_expected_room_usd, shadow_ceiling_room_usd, " +
          "snapshot_generation, snapshot_age_s, created_at",
      )
      .gte("created_at", since.toISOString())
      .order("id", { ascending: true })
      .range(from, to),
  );
  return compareShadowVerdicts(rows);
}
