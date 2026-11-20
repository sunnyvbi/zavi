import { AD_CHANNEL_CONSTRAINTS } from "@zavi/shared";
import { asTenantId, tenantClient, tenantRpc, fleetSweepClient } from "@/services/tenant-client";
import { dayWords } from "./budget-test-shape";
import { newObjectEnvelope, type NewObjectEnvelope } from "./test-envelope";
import type { TestEnd } from "./cgo-test-end";

export const TEST_STOP_PLATFORMS = ["meta", "google", "chatgpt", "tiktok"] as const;
export type TestStopPlatform = (typeof TEST_STOP_PLATFORMS)[number];
export type TestStopLevel = "campaign" | "ad_set" | "ad_group";
export type BillingScope = "object" | "campaign_budget";

export type LifetimeEnvelope = { kind: "lifetime_total"; amount_usd: number; started_at: string; ends_on: string };
export type TestStopEnvelope = NewObjectEnvelope | LifetimeEnvelope;

export type TestStopSpec = {
  decision_id: string;
  platform: TestStopPlatform;
  level: TestStopLevel;
  account_id: string;
  object_id: string;
  billing_scope: BillingScope;
  ends_on: string;
  started_at: string;
  envelope: TestStopEnvelope;
  name?: string;
  parent_object_id?: string;
};

const HOUR = 3_600_000;
export const FIRST_READ_GRACE_MS = 6 * HOUR;
export const DEFAULT_REPORTING_DELAY_HOURS = 24;

const CHANNEL_OF: Record<TestStopPlatform, string> = { meta: "meta_ads", google: "google_ads", chatgpt: "chatgpt_ads", tiktok: "tiktok_ads" };
const PLATFORM_OF: Record<string, TestStopPlatform> = { meta_ads: "meta", google_ads: "google", chatgpt_ads: "chatgpt", tiktok_ads: "tiktok" };

export function holdFactor(platform: string): number {
  const c = AD_CHANNEL_CONSTRAINTS.find((x) => x.platform === platform && x.channel_slug !== "youtube_ads");
  return c && Number.isFinite(c.hold_factor) && c.hold_factor > 0 ? c.hold_factor : 2;
}

export function testStopSpec(a: {
  testEnd: Pick<TestEnd, "decision_id" | "ends_on">;
  platform: TestStopPlatform;
  level: TestStopLevel;
  account_id: string;
  object_id: string;
  billing_scope: BillingScope;
  daily_usd?: number | null;
  lifetime_usd?: number | null;
  now: Date;
  name?: string;
  parent_object_id?: string;
}): TestStopSpec | null {
  if (!a.account_id || !a.object_id) return null;
  const started_at = a.now.toISOString();
  let envelope: TestStopEnvelope | null;
  if (typeof a.lifetime_usd === "number" && Number.isFinite(a.lifetime_usd) && a.lifetime_usd > 0) {
    envelope = Date.parse(`${a.testEnd.ends_on}T00:00:00Z`) > a.now.getTime()
      ? { kind: "lifetime_total", amount_usd: Math.round(a.lifetime_usd * 100) / 100, started_at, ends_on: a.testEnd.ends_on }
      : null;
  } else {
    envelope = newObjectEnvelope({ daily_usd: a.daily_usd, activated_at: started_at, ends_on: a.testEnd.ends_on });
  }
  if (!envelope || !(envelope.amount_usd > 0)) return null;
  return {
    decision_id: a.testEnd.decision_id,
    platform: a.platform,
    level: a.level,
    account_id: a.account_id,
    object_id: a.object_id,
    billing_scope: a.billing_scope,
    ends_on: a.testEnd.ends_on,
    started_at,
    envelope,
    ...(a.name ? { name: a.name.slice(0, 160) } : {}),
    ...(a.parent_object_id ? { parent_object_id: a.parent_object_id } : {}),
  };
}

export async function armTestStop(tenant_id: string, action_id: string, spec: TestStopSpec): Promise<string> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "arm_growth_test_stop", { p_action_id: action_id, p_spec: spec });
  const out = (data ?? {}) as { status?: string; id?: string };
  if (error || (out.status !== "armed" && out.status !== "exists") || !out.id) {
    throw new Error(`test stop not armed for ${spec.platform} ${spec.object_id}: ${error?.message ?? out.status ?? "no answer"}`);
  }
  return out.id;
}

export function testStopLine(e: TestStopEnvelope): string {
  const until = dayWords(e.ends_on) ?? e.ends_on;
  const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  return e.kind === "lifetime_total"
    ? `Runs until ${until}, planned about ${usd(e.amount_usd)} in total. Zavi pauses it if spend gets there.`
    : `Runs ${usd(e.daily_usd)}/day until ${until}, planned about ${usd(e.amount_usd)}. Zavi pauses it if spend gets there.`;
}

export type TestStopState = "monitoring" | "stopping" | "stop_failed" | "stopped" | "needs_attention" | "object_gone" | "founder_resumed";
export type TestStop = {
  id: string;
  decision_id: string;
  name: string;
  platform: TestStopPlatform;
  account_id: string;
  object_id: string;
  level: TestStopLevel;
  billing_scope: BillingScope;
  budget_usd: number;
  envelope: TestStopEnvelope;
  baseline: { date: string; amounts: Record<string, number> };
  started_at: string;
  ends_at: string;
  ends_on: string;
  source_action_id: string;
  parent_object_id: string | null;
  failing_since: string | null;
  spent_usd: number;
  spend_highwater: Record<string, number>;
  exposure_usd: number;
  state: TestStopState;
  reason: string | null;
  stop_requested_at: string | null;
  pause_action_id: string | null;
  checked_at: string | null;
  stopped_at: string | null;
};
const COLUMNS =
  "id, decision_id, name, platform, account_id, object_id, level, billing_scope, budget_usd, envelope, baseline, started_at, ends_at, ends_on, source_action_id, parent_object_id, failing_since, spent_usd, spend_highwater, exposure_usd, state, reason, stop_requested_at, pause_action_id, checked_at, stopped_at";
const PAGE = 1000;
const MAX_PAGES = 100;

export async function readPages<T>(what: string, page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; ; p++) {
    if (p >= MAX_PAGES) throw new Error(`${what}: more rows than one pass reads`);
    const { data, error } = await page(p * PAGE, (p + 1) * PAGE - 1);
    if (error) throw new Error(`${what} could not be read: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const toStop = (r: Record<string, unknown>): TestStop => ({
  ...(r as unknown as TestStop),
  budget_usd: Number(r.budget_usd),
  spent_usd: Number(r.spent_usd),
  exposure_usd: Number(r.exposure_usd),
  spend_highwater: (r.spend_highwater as Record<string, number> | null) ?? {},
});

export async function readTestStops(tenant_id: string, now: Date): Promise<TestStop[]> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const rows = await readPages<Record<string, unknown>>("test stops", (from, to) =>
    tenantClient(asTenantId(tenant_id))
      .from("growth_experiment_controls")
      .select(COLUMNS)
      .eq("tenant_id", tenant_id)
      .eq("kind", "test_stop")
      .or(`stopped_at.is.null,stopped_at.gte.${since}`)
      .order("started_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  return rows.map(toStop);
}

export async function testStopsForObjects(tenant_id: string, platform: TestStopPlatform, objectIds: string[]): Promise<TestStop[]> {
  const ids = [...new Set(objectIds.filter(Boolean))];
  if (!ids.length) return [];
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("growth_experiment_controls")
    .select(COLUMNS)
    .eq("tenant_id", tenant_id)
    .eq("kind", "test_stop")
    .eq("platform", platform)
    .in("object_id", ids)
    .order("started_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`test stops could not be read: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(toStop);
}

export async function tenantsWithTestStops(now: Date = new Date()): Promise<string[]> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const out: string[] = [];
  let after: string | null = null;
  for (;;) {
    const res: { data: unknown; error: { message: string } | null } = await fleetSweepClient("test stops: tenants with a stop to check").rpc("test_stop_tenants", { p_since: since, p_after: after, p_limit: PAGE });
    if (res.error) throw new Error(`test stop tenants could not be read: ${res.error.message}`);
    const ids: string[] = ((res.data ?? []) as unknown[]).map((r) => (typeof r === "string" ? r : String((r as Record<string, unknown>).test_stop_tenants ?? "")));
    out.push(...ids.filter(Boolean));
    if (ids.length < PAGE) return out;
    after = ids[ids.length - 1]!;
  }
}

const OPEN: ReadonlySet<TestStopState> = new Set(["monitoring", "stopping", "stop_failed", "needs_attention"]);
export const isOpenStop = (s: Pick<TestStop, "state" | "stopped_at">) => !s.stopped_at && OPEN.has(s.state);

export function statusCardObject(execClass: string, payload: unknown): { platform: TestStopPlatform; id: string; status: string } | null {
  const m = /^(meta_ads|google_ads|chatgpt_ads|tiktok_ads)\.set_status$/.exec(execClass);
  if (!m) return null;
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const raw = p.object_id ?? p.campaign_id;
  const id = typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
  return id ? { platform: PLATFORM_OF[m[1]!]!, id, status: String(p.status ?? "").toUpperCase() } : null;
}

export async function testStopPauseAuthority(tenant_id: string, action_id: string, execClass: string, payload: unknown): Promise<"stop" | "resumed" | null> {
  const card = statusCardObject(execClass, payload);
  if (!card || card.status !== "PAUSED") return null;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("growth_experiment_controls")
    .select("id, platform, object_id, state, stopped_at")
    .eq("tenant_id", tenant_id)
    .eq("kind", "test_stop")
    .eq("pause_action_id", action_id)
    .limit(2);
  if (error) throw new Error(`test stop authority unreadable: ${error.message}`);
  const rows = (data ?? []) as Array<Pick<TestStop, "id" | "platform" | "object_id" | "state" | "stopped_at">>;
  const row = rows.length === 1 ? rows[0]! : null;
  if (!row || row.platform !== card.platform || row.object_id !== card.id) return null;
  if (row.state === "founder_resumed") return "resumed";
  return isOpenStop(row) ? "stop" : null;
}

export function testStopHoldReason(stops: Pick<TestStop, "state" | "stopped_at" | "stop_requested_at">[], change: "on" | "raise"): string | null {
  const live = stops.filter((s) => s.state !== "founder_resumed");
  if (!live.length) return null;
  if (live.some((s) => !isOpenStop(s) || s.stop_requested_at)) return TEST_STOP_STOPPED;
  return change === "raise" ? TEST_STOP_RAISE : null;
}
export const TEST_STOP_STOPPED = "test_stop_stopped";
export const TEST_STOP_RAISE = "test_stop_raise";

type InventoryRow = {
  platform: string;
  account_id: string;
  object_id: string;
  level: string;
  campaign_id: string | null;
  name: string | null;
  budget_kind: string;
  budget_usd: number | null;
  status: string | null;
  currency: string;
  as_of: string;
};
type SpendRow = { object_id: string; spend_date: string; amount_usd: number | string };

const stoppedStatus = (s: string | null) => /^(PAUSED|ARCHIVED|REMOVED|DELETED|DELETE|ENDED|CAMPAIGN_PAUSED|DISABLE)$/i.test(s ?? "");
const fresh = (asOf: string, now: Date) => {
  const t = Date.parse(asOf);
  return Number.isFinite(t) && now.getTime() - t >= 0 && now.getTime() - t <= 3 * HOUR;
};

async function readTarget(tenant_id: string, s: TestStop): Promise<{ target: InventoryRow | null; spendObjects: InventoryRow[]; children: InventoryRow[] }> {
  const db = tenantClient(asTenantId(tenant_id));
  const cols = "platform, account_id, object_id, level, campaign_id, name, budget_kind, budget_usd, status, currency, as_of";
  const own = await db.from("ad_campaigns").select(cols).eq("tenant_id", tenant_id).eq("platform", s.platform).eq("account_id", s.account_id).eq("source", "api").eq("object_id", s.object_id).limit(2);
  if (own.error) throw new Error(`test stop object read failed: ${own.error.message}`);
  const norm = (r: Record<string, unknown>) => ({ ...r, budget_usd: r.budget_usd == null ? null : Number(r.budget_usd) }) as InventoryRow;
  const target = ((own.data ?? []) as Record<string, unknown>[]).map(norm)[0] ?? null;
  if (!target) return { target: null, spendObjects: [], children: [] };
  if (s.billing_scope === "campaign_budget") {
    const kids = await readPages<Record<string, unknown>>("test stop ad sets", (from, to) =>
      db.from("ad_campaigns").select(cols).eq("tenant_id", tenant_id).eq("platform", s.platform).eq("account_id", s.account_id).eq("source", "api").eq("campaign_id", s.object_id).neq("object_id", s.object_id).order("object_id").range(from, to),
    );
    const children = kids.map(norm);
    return { target, spendObjects: children, children };
  }
  if (s.platform === "tiktok" && s.level === "ad_group" && target.campaign_id) {
    const parent = await db.from("ad_campaigns").select(cols).eq("tenant_id", tenant_id).eq("platform", "tiktok").eq("account_id", s.account_id).eq("source", "api").eq("object_id", target.campaign_id).limit(2);
    if (parent.error) throw new Error(`test stop campaign read failed: ${parent.error.message}`);
    const p = ((parent.data ?? []) as Record<string, unknown>[]).map(norm)[0];
    return { target, spendObjects: p ? [p] : [], children: [] };
  }
  return { target, spendObjects: [target], children: [] };
}

async function readSpend(tenant_id: string, s: TestStop, objects: InventoryRow[], until?: string): Promise<SpendRow[]> {
  if (!objects.length) return [];
  return readPages<SpendRow>("test stop spend", (from, to) => {
    let q = tenantClient(asTenantId(tenant_id))
      .from("ad_spend_daily")
      .select("object_id, spend_date, amount_usd")
      .eq("tenant_id", tenant_id)
      .eq("platform", s.platform)
      .eq("account_id", s.account_id)
      .eq("source", "api")
      .in("object_id", objects.map((o) => o.object_id))
      .gte("spend_date", s.baseline.date);
    if (until) q = q.lte("spend_date", until);
    return q.order("object_id").order("spend_date").range(from, to);
  });
}

export function stopSpendReading(s: Pick<TestStop, "baseline" | "spent_usd" | "spend_highwater">, rows: SpendRow[]) {
  const highwater = { ...s.spend_highwater };
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.object_id}:${r.spend_date}`;
    const value = Number(r.amount_usd);
    if (!Number.isFinite(value) || value < 0 || seen.has(key)) throw new Error("Invalid or duplicated test spend.");
    seen.add(key);
    highwater[key] = Math.max(highwater[key] ?? 0, value - (s.baseline.amounts[key] ?? 0));
  }
  const total = Object.values(highwater).reduce((n, v) => n + v, 0);
  return { spent_usd: Math.ceil(Math.max(s.spent_usd, total) * 100) / 100, spend_highwater: highwater };
}

export function assessTestStop(
  s: Pick<TestStop, "platform" | "budget_usd" | "ends_at" | "started_at" | "envelope" | "stop_requested_at" | "state">,
  t: { daily_usd: number | null; budget_kind: string; as_of: string; status: string | null } | null,
  spent: number | null,
  reportingDelayHours: number,
  now: Date,
): { stop: boolean; wait: boolean; exposure_usd: number; reason: string | null; paused: boolean } {
  const ended = now.getTime() >= Date.parse(s.ends_at);
  const young = now.getTime() - Date.parse(s.started_at) < FIRST_READ_GRACE_MS;
  const latched = !!s.stop_requested_at || s.state === "stopping" || s.state === "stop_failed";
  const isFresh = !!t && fresh(t.as_of, now);
  const paused = isFresh && stoppedStatus(t!.status);
  if (spent === null || !t) {
    if (ended || latched) return { stop: true, wait: false, exposure_usd: s.budget_usd, reason: ended ? "The test reached its end date." : null, paused };
    if (young) return { stop: false, wait: true, exposure_usd: 0, reason: "Waiting for the first platform read of this new ad.", paused };
    return { stop: true, wait: false, exposure_usd: s.budget_usd, reason: "Zavi could not read this test's spend, so it pauses it to protect the planned spend.", paused };
  }
  const daily = Number(t.daily_usd);
  const hours = reportingDelayHours + 1 + Math.max(0, (now.getTime() - Date.parse(t.as_of)) / HOUR);
  const capped = t.budget_kind === "lifetime" && Number.isFinite(daily) && daily > 0 && daily <= s.budget_usd;
  const exposure = capped ? spent : Number.isFinite(daily) && daily > 0 ? spent + (daily * holdFactor(s.platform) * hours) / 24 : Number.POSITIVE_INFINITY;
  const reason = ended
    ? "The test reached its end date."
    : spent >= s.budget_usd
      ? "The test reached its planned spend."
      : !isFresh
        ? young ? null : "Spend reporting is stale; pausing protects the planned spend."
        : exposure >= s.budget_usd
          ? "The test is close enough to its planned spend that reporting delay could carry it past."
          : null;
  return {
    stop: !!reason || latched,
    wait: !reason && !latched && !isFresh && young,
    exposure_usd: Number.isFinite(exposure) ? Math.ceil(exposure * 100) / 100 : s.budget_usd,
    reason,
    paused,
  };
}

type PauseAction = { id: string; status: string | null; exec_status: string | null; executed_at: string | null; exec_claimed_at: string | null; approved_by_source: string | null; proposed_at?: string | null };

export const PAUSE_INFLIGHT_MS = 2 * HOUR;

export function pauseIsInFlight(a: Pick<PauseAction, "status" | "exec_status" | "exec_claimed_at" | "proposed_at"> | null, now: Date): boolean {
  if (!a) return false;
  const waiting = a.exec_status === "queued" || a.exec_status === "dispatching" || (a.status === "pending" && a.exec_status === null);
  if (!waiting) return false;
  const since = Date.parse(a.exec_claimed_at ?? a.proposed_at ?? "");
  return Number.isFinite(since) && now.getTime() - since < PAUSE_INFLIGHT_MS;
}

async function readPauseAction(tenant_id: string, id: string): Promise<PauseAction | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_actions")
    .select("id, status, exec_status, executed_at, exec_claimed_at, approved_by_source, proposed_at")
    .eq("tenant_id", tenant_id)
    .eq("id", id)
    .maybeSingle<PauseAction>();
  if (error) throw new Error(`test stop pause read failed: ${error.message}`);
  return data ?? null;
}

async function objectActions(tenant_id: string, s: TestStop, now: Date): Promise<{ inflight: boolean; latest: number }> {
  const rows = await readPages<{ exec_status: string | null; executed_at: string | null; exec_claimed_at: string | null; proposed_at: string | null; exec_payload: Record<string, unknown> | null }>("test stop actions", (from, to) =>
    tenantClient(asTenantId(tenant_id))
      .from("channel_actions")
      .select("exec_status, executed_at, exec_claimed_at, proposed_at, exec_payload")
      .eq("tenant_id", tenant_id)
      .eq("channel_slug", CHANNEL_OF[s.platform])
      .like("exec_class", "%.set_status")
      .gte("proposed_at", s.started_at)
      .order("proposed_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  let inflight = false;
  let latest = 0;
  for (const a of rows) {
    const p = a.exec_payload ?? {};
    if (String(p.object_id ?? p.campaign_id ?? "") !== s.object_id) continue;
    if ((a.exec_status === "queued" || a.exec_status === "dispatching") && now.getTime() - (Date.parse(a.exec_claimed_at ?? a.proposed_at ?? "") || 0) < PAUSE_INFLIGHT_MS) inflight = true;
    latest = Math.max(latest, Date.parse(a.executed_at ?? a.exec_claimed_at ?? "") || 0);
  }
  return { inflight, latest };
}

async function saveCheck(tenant_id: string, s: TestStop, check: Record<string, unknown>, locked = true): Promise<void> {
  const r = await tenantRpc(asTenantId(tenant_id), "record_growth_experiment_check", { p_id: s.id, p_check: locked ? { expected_checked_at: s.checked_at, ...check } : check });
  if (r.error) throw new Error(`test stop check not saved: ${r.error.message}`);
}

export type TestStopDeps = {
  reportingDelayHours: (tenant_id: string) => Promise<number>;
  submitPause: (tenant_id: string, s: TestStop, target: InventoryRow | null, reason: string, now: Date) => Promise<{ ok: true; action_id: string } | { ok: false; why: string }>;
  approvePause: (tenant_id: string, action_id: string) => Promise<boolean>;
  tellFounder: (tenant_id: string, s: TestStop, why: string) => Promise<void>;
  log: (tenant_id: string, code: string, message: string) => void;
};

export async function monitorTestStops(tenant_id: string, now: Date = new Date(), deps: TestStopDeps = defaultDeps): Promise<{ checked: number; pausing: number }> {
  const stops = await readTestStops(tenant_id, now);
  let pausing = 0;
  const failures = new Map<string, string>();
  const delay = stops.some((s) => isOpenStop(s)) ? await deps.reportingDelayHours(tenant_id) : DEFAULT_REPORTING_DELAY_HOURS;
  for (const s of stops) {
    if (s.state === "founder_resumed" || s.state === "object_gone") continue;
    const failing = { ...s, failing_since: s.failing_since ?? now.toISOString() };
    const base = { spent_usd: s.spent_usd, exposure_usd: s.exposure_usd, failing_since: failing.failing_since };
    let check: Record<string, unknown>;
    try {
      const { target, spendObjects, children } = await readTarget(tenant_id, s);
      if (target && /^removed$/i.test(target.status ?? "") && Date.parse(target.as_of) > Date.parse(s.started_at)) {
        await saveCheck(tenant_id, s, { ...base, state: "object_gone", reason: "The ad was removed from the ad account, so there is nothing left to pause." });
        continue;
      }
      const scopeKnown = !!target && (s.billing_scope !== "campaign_budget" || children.length > 0) && spendObjects.length > 0;
      let reading: { spent_usd: number; spend_highwater: Record<string, number> } | null = null;
      if (scopeKnown) {
        try {
          const until = s.stopped_at ? new Date(Date.parse(s.stopped_at) + 24 * HOUR).toISOString().slice(0, 10) : undefined;
          reading = stopSpendReading(s, await readSpend(tenant_id, s, spendObjects, until));
        } catch (e) {
          deps.log(tenant_id, "cgo.test_stop_spend_unreadable", `stop=${s.id}: ${(e as Error).message.slice(0, 200)}`);
          if (!failures.has(s.id)) failures.set(s.id, "spend unreadable");
        }
      }
      const a = assessTestStop(s, target ? { daily_usd: target.budget_usd, budget_kind: target.budget_kind, as_of: target.as_of, status: target.status } : null, reading?.spent_usd ?? null, delay, now);
      check = { ...base, ...(reading ? { spent_usd: reading.spent_usd, spend_highwater: reading.spend_highwater } : {}), exposure_usd: Math.max(a.exposure_usd, reading?.spent_usd ?? 0), stop: a.stop, reason: a.reason ?? s.reason, state: "monitoring" };
      if (s.stopped_at) {
        await saveCheck(tenant_id, s, { ...check, stop: false, state: "stopped" });
        continue;
      }
      if (!a.stop) {
        await saveCheck(tenant_id, s, check);
        continue;
      }
      const acts = await objectActions(tenant_id, s, now);
      if (a.paused && target && !acts.inflight && Date.parse(target.as_of) > acts.latest) {
        await saveCheck(tenant_id, s, { ...check, state: "stopped" });
        continue;
      }
      if (s.pause_action_id) {
        const prior = await readPauseAction(tenant_id, s.pause_action_id);
        const onItsWay = pauseIsInFlight(prior, now);
        if (onItsWay && prior!.status === "pending" && prior!.exec_status === null) {
          const sent = await deps.approvePause(tenant_id, prior!.id);
          await saveCheck(tenant_id, s, { ...check, state: sent ? "stopping" : "stop_failed", reason: sent ? check.reason : "Zavi could not send the pause it filed; it tries again next hour." });
          if (sent) pausing++;
          continue;
        }
        const ranBeforeRead = prior?.exec_status === "executed" && target && Date.parse(target.as_of) <= (Date.parse(prior.executed_at ?? "") || 0);
        if (acts.inflight || onItsWay || ranBeforeRead) {
          await saveCheck(tenant_id, s, { ...check, state: "stopping", reason: "Waiting for the pause and a newer platform read." });
          continue;
        }
      }
      const result = await deps.submitPause(tenant_id, s, target, String(a.reason ?? "The test's stop is due."), now);
      if (result.ok) {
        pausing++;
        await saveCheck(tenant_id, s, { ...check, state: "stopping", pause_action_id: result.action_id }, false);
        continue;
      }
      deps.log(tenant_id, "cgo.test_stop_pause_failed", `stop=${s.id} object=${s.object_id}: ${result.why.slice(0, 200)}`);
      failures.set(s.id, "pause not filed");
      await deps.tellFounder(tenant_id, failing, result.why);
      await saveCheck(tenant_id, s, { ...check, state: "stop_failed", reason: `The pause could not be filed: ${result.why}` }, false);
    } catch (e) {
      const why = (e as Error).message.slice(0, 300);
      deps.log(tenant_id, "cgo.test_stop_check_failed", `stop=${s.id}: ${why.slice(0, 200)}`);
      failures.set(s.id, why.slice(0, 120));
      let paused = false;
      const pauseInFlight = s.pause_action_id ? pauseIsInFlight(await readPauseAction(tenant_id, s.pause_action_id).catch(() => null), now) : false;
      if (!s.stopped_at && !pauseInFlight && now.getTime() - Date.parse(s.started_at) >= FIRST_READ_GRACE_MS) {
        const r = await deps.submitPause(tenant_id, s, null, "Zavi could not check this test's spend, so it pauses it to protect the planned spend.", now).catch((pe: Error) => ({ ok: false as const, why: pe.message }));
        paused = r.ok;
        if (r.ok) pausing++;
        else deps.log(tenant_id, "cgo.test_stop_pause_failed", `stop=${s.id} object=${s.object_id}: ${r.why.slice(0, 200)}`);
      }
      if (!paused && !pauseInFlight) await deps.tellFounder(tenant_id, failing, why);
      if (!paused) {
        try {
          await saveCheck(tenant_id, s, { ...base, state: "needs_attention", reason: why }, false);
        } catch (saveError) {
          deps.log(tenant_id, "cgo.test_stop_check_not_saved", `stop=${s.id}: ${(saveError as Error).message.slice(0, 200)}`);
        }
      }
    }
  }
  if (failures.size) throw new Error(`test stops for ${tenant_id}: ${failures.size} of ${stops.length} could not be checked (${[...failures].slice(0, 3).map(([id, w]) => `${id}: ${w}`).join("; ")})`);
  return { checked: stops.length, pausing };
}

export async function tellFounderTestStopFailed(tenant_id: string, s: TestStop, why: string, reason: string = TEST_STOP_MONITOR_FAILED): Promise<void> {
  try {
    const raced = reason === TEST_STOP_PAUSE_RACED;
    const { alertFounderSafely } = await import("./cgo-blockers");
    await alertFounderSafely(tenant_id, raced ? "test stop pause crossed a switch-on" : "test stop not checked", [
      {
        id: `test-stop:${s.id}:${reason}`,
        kind: raced ? "ad_delivery" : "stuck",
        what: raced
          ? `Zavi's pause for the test "${s.name}" and your switch-on crossed, so the ad may be paused now.`
          : `Zavi could not check or pause the spend of the test "${s.name}" this hour (${why.slice(0, 160)}).`,
        who: "you",
        since: raced ? (s.checked_at ?? s.started_at) : (s.failing_since ?? s.started_at),
        usd_at_stake: null,
        at_risk_now: !raced,
        ...(raced ? { notify_now: true } : {}),
        meanwhile: raced ? "Check the ad, and switch it on again if you want it running." : "Pause it in the ad platform if it should not keep running; Zavi tries again next hour.",
        channel_slug: CHANNEL_OF[s.platform],
      },
    ]);
  } catch (e) {
    console.warn(`[test-stops] founder not told about stop ${s.id}: ${(e as Error).message.slice(0, 200)}`);
  }
}
export const TEST_STOP_MONITOR_FAILED = "test_stop_monitor_failed";

export async function testStopPauseBody(tenant_id: string, s: TestStop, target: InventoryRow | null, reason: string): Promise<Record<string, unknown>> {
  const name = (target?.name ?? s.name).slice(0, 300) || "Zavi test";
  if (s.platform === "chatgpt") {
    const { readCampaignTree } = await import("@/services/connectors/chatgpt-ads/workspace");
    const { launchSnapshot } = await import("@/services/connectors/chatgpt-ads/launch");
    const { withChatgptBudgetCampaign } = await import("@/services/ads-wallet/chatgpt-budget-identity");
    const tree = await withChatgptBudgetCampaign(tenant_id, s.object_id, (id) => readCampaignTree(tenant_id, id));
    return { campaign_id: s.object_id, status: "PAUSED", rationale: reason, summary: reason, name: tree.campaign.name ?? name, origin: "agent", expected_updated_at: tree.campaign.updated_at, snapshot: launchSnapshot(tree) };
  }
  if (s.platform === "tiktok") {
    const campaign_id = target?.campaign_id ?? s.parent_object_id;
    if (!campaign_id) throw new Error("the ad group's campaign is not known");
    return {
      advertiser_id: s.account_id,
      advertiser_name: `TikTok ad account ${s.account_id}`,
      object_id: s.object_id,
      campaign_id,
      ad_group_id: s.object_id,
      level: "ad_group",
      name,
      rationale: reason,
      status: "PAUSED",
      expected_current_status: "ACTIVE",
      daily_budget_usd: target?.budget_usd != null && target.budget_usd > 0 ? target.budget_usd : null,
    };
  }
  if (s.platform === "meta") return { object_id: s.object_id, level: s.level === "ad_set" ? "adset" : "campaign", status: "PAUSED", rationale: reason, over_cap: false, name };
  return { campaign_id: s.object_id, level: "campaign", status: "PAUSED", rationale: reason, over_cap: false, name };
}

export async function submitTestStopPause(tenant_id: string, s: TestStop, target: InventoryRow | null, reason: string, now: Date): Promise<{ ok: true; action_id: string } | { ok: false; why: string }> {
  try {
    const channel = CHANNEL_OF[s.platform];
    const body = await testStopPauseBody(tenant_id, s, target, `Zavi paused this test: ${reason}`);
    const { ensureCgoOrderRun, orderCard } = await import("./cgo-ad-orders");
    const run_id = await ensureCgoOrderRun(tenant_id, channel as Parameters<typeof ensureCgoOrderRun>[1], now);
    const execClass = `${channel}.set_status`;
    const { title, card } = await orderCard({ tenant_id, channel_slug: channel, exec_class: execClass, body, reason: `Zavi paused this test: ${reason}`, idempotency_key: `test-stop:${s.id}`, now } as Parameters<typeof orderCard>[0]);
    const { recordChannelExecAction } = await import("@/services/channels/exec-actions");
    const recorded = await recordChannelExecAction(
      { tenantId: tenant_id, runId: run_id, channelSlug: channel, execClass, execPayload: body, actionType: "pause_ad", title, body: card },
      undefined,
      { enabled: () => false, cgoDoor: false },
    );
    if (recorded.kept || recorded.id === s.pause_action_id) {
      return { ok: false, why: `an earlier card on this ad (${recorded.id}) is still open or stuck, so no new pause could be filed` };
    }
    const linked = await tenantRpc(asTenantId(tenant_id), "record_growth_experiment_check", {
      p_id: s.id,
      p_check: { expected_checked_at: s.checked_at, spent_usd: s.spent_usd, exposure_usd: s.exposure_usd, state: "stopping", stop: true, reason, pause_action_id: recorded.id },
    });
    if (linked.error) return { ok: false, why: `link: ${linked.error.message.slice(0, 160)}` };
    if (linked.data !== "applied") return { ok: false, why: `the pause was filed but not linked (${String(linked.data ?? "no answer")}); it is not approved` };
    const sent = await approveTestStopPause(tenant_id, recorded.id);
    return sent ? { ok: true, action_id: recorded.id } : { ok: false, why: "the pause was filed but not approved; it is retried next hour" };
  } catch (e) {
    return { ok: false, why: (e as Error).message.slice(0, 200) };
  }
}

export async function approveTestStopPause(tenant_id: string, action_id: string): Promise<boolean> {
  const { tenantOwnerId } = await import("./cgo-auto-run");
  const owner = await tenantOwnerId(tenant_id);
  if (!owner) return false;
  const { approveChannelAction } = await import("@/services/channels/exec-actions");
  const r = await approveChannelAction(tenant_id, { actionId: action_id, eventKey: `test-stop:${action_id}`, actorUserId: owner, source: "cgo" });
  if (!r.ok) return false;
  const { inngest } = await import("@/../workers/client");
  await inngest.send({ id: `approve:${action_id}:${r.attempt}`, name: "channel-action.approved", data: { action_id } });
  return true;
}

const defaultDeps: TestStopDeps = {
  reportingDelayHours: async (tenant_id) => {
    const { readBusinessPolicy } = await import("./business-control-policy");
    const p = await readBusinessPolicy(tenant_id).catch(() => null);
    return p?.reporting_delay_hours ?? DEFAULT_REPORTING_DELAY_HOURS;
  },
  submitPause: submitTestStopPause,
  approvePause: approveTestStopPause,
  tellFounder: tellFounderTestStopFailed,
  log: (tenant_id, code, message) => {
    void import("@/services/logging/logEvent").then(({ logEvent }) => logEvent({ level: "warn", source: "test-stops", code, message, tenant_id })).catch(() => {});
  },
};

export async function armCreatedTestStop(
  tenant_id: string,
  action_id: string,
  testEnd: Pick<TestEnd, "decision_id" | "ends_on"> | null,
  o: Omit<Parameters<typeof testStopSpec>[0], "testEnd" | "now" | "account_id"> & { account_id: string | (() => Promise<string>) },
  now: Date = new Date(),
): Promise<{ ok: true; line: string | null } | { ok: false; why: string }> {
  if (!testEnd) return { ok: true, line: null };
  try {
    const account_id = typeof o.account_id === "function" ? await o.account_id() : o.account_id;
    const spec = testStopSpec({ ...o, account_id, testEnd, now });
    if (!spec) throw new Error("the test's spend could not be priced (no usable daily budget or end date)");
    await armTestStop(tenant_id, action_id, spec);
    return { ok: true, line: testStopLine(spec.envelope) };
  } catch (e) {
    const why = (e as Error).message.slice(0, 200);
    try {
      const { logEvent } = await import("@/services/logging/logEvent");
      void logEvent({ level: "error", source: "test-stops", code: "test_stop_not_armed", tenant_id, message: `action=${action_id} ${o.platform} ${o.object_id}: ${why}; not switched on by Zavi` });
    } catch {
    }
    return { ok: false, why };
  }
}

export function testStopChange(execClass: string, payload: unknown): { platform: TestStopPlatform; ids: string[]; change: "on" | "raise"; level: string | null } | null {
  const cls = execClass.replace(/_review$/, "");
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : null);
  const ids = (...vs: unknown[]) => [...new Set(vs.map(str).filter((x): x is string => !!x))];
  const up = (from: unknown, to: unknown) => Number(to) > Number(from);
  const on = String(p.status ?? "").toUpperCase();
  switch (cls) {
    case "meta_ads.set_status":
      return on === "ACTIVE" ? { platform: "meta", ids: ids(p.object_id, p.campaign_id), change: "on", level: str(p.level) } : null;
    case "meta_ads.update_ad_set_budget":
      return up(p.expected_current_daily_budget_usd, p.daily_budget_usd) ? { platform: "meta", ids: ids(p.ad_set_id, p.campaign_id), change: "raise", level: "adset" } : null;
    case "meta_ads.update_campaign_budget":
      return up(p.expected_current_daily_budget_usd, p.daily_budget_usd) ? { platform: "meta", ids: ids(p.campaign_id), change: "raise", level: "campaign" } : null;
    case "google_ads.set_status":
      return on === "ENABLED" ? { platform: "google", ids: ids(p.campaign_id), change: "on", level: "campaign" } : null;
    case "google_ads.update_campaign_budget":
      return up(p.expected_current_daily_budget_usd, p.daily_budget_usd) ? { platform: "google", ids: ids(p.campaign_id), change: "raise", level: "campaign" } : null;
    case "tiktok_ads.set_status":
      return on === "ACTIVE" ? { platform: "tiktok", ids: ids(p.object_id, p.ad_group_id, p.campaign_id), change: "on", level: str(p.level) } : null;
    case "tiktok_ads.update_budget":
      return up(p.expected_current_daily_budget_usd, p.daily_budget_usd) ? { platform: "tiktok", ids: ids(p.object_id, p.campaign_id), change: "raise", level: str(p.level) } : null;
    case "chatgpt_ads.set_status":
      return on === "ACTIVE" ? { platform: "chatgpt", ids: ids(p.campaign_id), change: "on", level: "campaign" } : null;
    case "chatgpt_ads.update_campaign_budget":
      return up(p.expected_current_daily_budget_usd, p.daily_budget_usd) ? { platform: "chatgpt", ids: ids(p.campaign_id), change: "raise", level: "campaign" } : null;
    default:
      return null;
  }
}

async function parentCampaigns(tenant_id: string, platform: TestStopPlatform, ids: string[]): Promise<string[]> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("ad_campaigns")
    .select("campaign_id")
    .eq("tenant_id", tenant_id)
    .eq("platform", platform)
    .in("object_id", ids)
    .limit(50);
  if (error) throw new Error(`parent campaign read failed: ${error.message}`);
  return ((data ?? []) as Array<{ campaign_id: string | null }>).map((r) => r.campaign_id).filter((x): x is string => !!x);
}

export async function testStopGateReason(tenant_id: string, execClass: string, payload: unknown): Promise<string | null> {
  const c = testStopChange(execClass, payload);
  if (!c || !c.ids.length) return null;
  const ids = c.platform === "meta" ? [...new Set([...c.ids, ...(await parentCampaigns(tenant_id, c.platform, c.ids))])] : c.ids;
  const stops = await testStopsForObjects(tenant_id, c.platform, ids);
  const held = testStopHoldReason(stops, c.change);
  if (held) return held;
  const open = stops.filter((s) => isOpenStop(s));
  if (c.change !== "on" || !open.length) return null;
  if (c.platform === "tiktok" || c.platform === "chatgpt") return TEST_STOP_SWITCH_ON;
  const { liveEndWithinTest } = await import("./cgo-test-end-live");
  for (const s of open) {
    const level = s.level === "ad_set" ? "adset" : "campaign";
    if (!(await liveEndWithinTest(tenant_id, s.platform as "meta" | "google", level, s.object_id, s.ends_on))) return TEST_STOP_SWITCH_ON;
  }
  return null;
}
export const TEST_STOP_SWITCH_ON = "test_stop_switch_on";

export function testStopCardLine(envelope: unknown, state: string): string | null {
  const e = envelope as Partial<TestStopEnvelope> | null;
  if (!e || typeof e.amount_usd !== "number" || !(e.amount_usd > 0) || typeof e.ends_on !== "string") return null;
  if (e.kind !== "lifetime_total" && (e.kind !== "gross_since_start" || typeof e.daily_usd !== "number")) return null;
  const line = testStopLine(e as TestStopEnvelope);
  if (state === "stopped") return `${line} Zavi paused it.`;
  if (state === "founder_resumed") return `${line} You switched it back on, so Zavi no longer pauses it.`;
  return line;
}

export async function afterTestStopPause(tenant_id: string, action_id: string, execClass: string, payload: unknown, pauseStartedAt: string = new Date().toISOString()): Promise<"ok" | "raced_resume"> {
  try {
    const card = statusCardObject(execClass, payload);
    if (!card) return "ok";
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("growth_experiment_controls")
      .select(COLUMNS)
      .eq("tenant_id", tenant_id)
      .eq("kind", "test_stop")
      .eq("pause_action_id", action_id)
      .limit(1);
    if (error) throw new Error(error.message);
    const row = ((data ?? []) as Record<string, unknown>[]).map(toStop)[0];
    if (!row || row.object_id !== card.id) return "ok";
    const crossed = row.state === "founder_resumed" || (await personSwitchOnCrossing(tenant_id, row, pauseStartedAt));
    if (!crossed) return "ok";
    defaultDeps.log(tenant_id, "cgo.test_stop_pause_raced_resume", `stop=${row.id} object=${row.object_id} action=${action_id}: paused after the founder switched it back on`);
    await tellFounderTestStopFailed(tenant_id, row, "Zavi's pause for this test and your switch-on crossed, so the ad may be paused now. Check it, and switch it on again if you want it running.", TEST_STOP_PAUSE_RACED);
    return "raced_resume";
  } catch (e) {
    defaultDeps.log(tenant_id, "cgo.test_stop_after_pause_unread", `action=${action_id}: ${(e as Error).message.slice(0, 200)}`);
    return "ok";
  }
}
export const TEST_STOP_PAUSE_RACED = "test_stop_pause_raced_resume";

async function personSwitchOnCrossing(tenant_id: string, s: TestStop, since: string): Promise<boolean> {
  const LIMIT = 200;
  const channel = CHANNEL_OF[s.platform];
  const { humanApproved } = await import("./unattended-policy");
  const db = tenantClient(asTenantId(tenant_id));
  const on = (p: Record<string, unknown> | null) =>
    !!p && String(p.object_id ?? p.campaign_id ?? "") === s.object_id && ["ACTIVE", "ENABLED"].includes(String(p.status ?? "").toUpperCase());
  const cards = await db
    .from("channel_actions")
    .select("exec_status, executed_at, exec_payload, approved_by, approved_by_source")
    .eq("tenant_id", tenant_id)
    .eq("channel_slug", channel)
    .like("exec_class", "%.set_status%")
    .or(`exec_status.in.(queued,dispatching),executed_at.gte.${since}`)
    .limit(LIMIT);
  if (cards.error) throw new Error(cards.error.message);
  const cardRows = (cards.data ?? []) as Array<{ exec_payload: Record<string, unknown> | null; approved_by: string | null; approved_by_source: string | null }>;
  if (cardRows.length >= LIMIT || cardRows.some((a) => humanApproved(a) && on(a.exec_payload))) return true;
  const decs = await db
    .from("decisions")
    .select("status, dispatched_at, body, approved_by, approved_by_source")
    .eq("tenant_id", tenant_id)
    .like("decision_class", `${channel}.set_status%`)
    .or(`status.in.(approved,dispatching),dispatched_at.gte.${since}`)
    .not("approved_by", "is", null)
    .limit(LIMIT);
  if (decs.error) throw new Error(decs.error.message);
  const decRows = (decs.data ?? []) as Array<{ body: Record<string, unknown> | null; approved_by: string | null; approved_by_source: string | null }>;
  return decRows.length >= LIMIT || decRows.some((d) => humanApproved(d) && on(d.body));
}

