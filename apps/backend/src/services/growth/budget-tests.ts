
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { parseBudgetTest, type MoveTest } from "./cgo-test-shape";
import type { BudgetPlatform } from "./founder-set-budget";
import { budgetTestRevertReason, budgetTestWords, dayWords, type BudgetTestFact } from "./budget-test-shape";
import { isServerEnvelope, legacyTestTotalUsd, raiseEnvelope, steppedRaiseStopUsd, testEndsOn } from "./test-envelope";

export const BUDGET_CLASSES: Readonly<Record<string, BudgetPlatform>> = {
  "meta_ads.update_ad_set_budget": "meta",
  "meta_ads.update_ad_set_budget_review": "meta",
  "meta_ads.update_campaign_budget": "meta",
  "meta_ads.update_campaign_budget_review": "meta",
  "google_ads.update_campaign_budget": "google",
  "google_ads.update_campaign_budget_review": "google",
  "chatgpt_ads.update_campaign_budget": "chatgpt",
  "tiktok_ads.update_budget": "tiktok",
};
const CGO_CARD_CLASS = "cgo.dispatch-specialist";
export const TEST_REVERT_OF = "test_revert_of";
export const TEST_REVERT_OBJECT = "test_revert_object";
const LOOKBACK_DAYS = 45;
const MOVE_LOOKBACK_DAYS = 90;
export const REVERT_GRACE_DAYS = 3;
const DAY = 86_400_000;
const PAGE = 500;
const IN_CHUNK = 100;
const FRESH_MS = 3 * 3_600_000;

export type BudgetTest = {
  decision_id: string;
  emitted_at: string;
  test: MoveTest;
  platform: BudgetPlatform;
  channel_slug: string;
  exec_class: string;
  object_id: string;
  card_id: string;
  run_ids: string[];
  body: Record<string, unknown>;
  launched_at: string;
  baseline_daily_usd: number | null;
  steps?: Array<{ daily_usd: number; executed_at: string }>;
  ends_on: string;
  reverted: boolean;
  baselineInvalid?: boolean;
};

export type TestCard = { id: string; emitted_at: string; body: Record<string, unknown> | null };
export type TestRun = { id: string; source_decision_id: string | null };
export type TestAction = {
  id: string;
  run_id: string | null;
  exec_class: string | null;
  exec_status: string | null;
  executed_at: string | null;
  exec_payload: unknown;
  edited_body?: unknown;
};

export function budgetObjectOf(platform: BudgetPlatform, body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const id = platform === "meta" ? (b.ad_set_id ?? b.campaign_id) : platform === "tiktok" ? b.object_id : b.campaign_id;
  return typeof id === "string" && id ? id : null;
}

const dayOf = (iso: string) => iso.slice(0, 10);
export { testEndsOn };
export const testEndsAt = (t: Pick<BudgetTest, "ends_on">) => Date.parse(`${t.ends_on}T00:00:00Z`);

export function budgetTestsFrom(cards: readonly TestCard[], runs: readonly TestRun[], actions: readonly TestAction[], reverted: ReadonlySet<string>): BudgetTest[] {
  const out: BudgetTest[] = [];
  for (const c of cards) {
    const b = c.body ?? {};
    if (b.dispatched_by !== "cgo") continue;
    const { test, baselineInvalid } = parseBudgetTest(b.test);
    if (!test) continue;
    const runIds = runs.filter((r) => r.source_decision_id === c.id).map((r) => r.id);
    const seen = new Map<string, { first: TestAction & { executed_at: string }; firstBody: Record<string, unknown>; latest: TestAction & { executed_at: string }; body: Record<string, unknown>; platform: BudgetPlatform; object_id: string; steps: Array<{ daily_usd: number; executed_at: string }> }>();
    for (const a of actions) {
      if (!a.run_id || !runIds.includes(a.run_id) || a.exec_status !== "executed" || !a.executed_at) continue;
      const platform = a.exec_class ? BUDGET_CLASSES[a.exec_class] : undefined;
      if (!platform) continue;
      const body = (a.edited_body && typeof a.edited_body === "object" ? a.edited_body : a.exec_payload) as Record<string, unknown> | null;
      const object_id = budgetObjectOf(platform, body);
      if (!body || !object_id) continue;
      const key = `${platform}:${object_id}`;
      const at = Date.parse(a.executed_at);
      const done = { ...a, executed_at: a.executed_at };
      const prev = seen.get(key);
      const step = { daily_usd: Number(body.daily_budget_usd), executed_at: a.executed_at };
      if (!prev) {
        seen.set(key, { first: done, firstBody: body, latest: done, body, platform, object_id, steps: [step] });
        continue;
      }
      prev.steps.push(step);
      if (at < Date.parse(prev.first.executed_at)) Object.assign(prev, { first: done, firstBody: body });
      if (at > Date.parse(prev.latest.executed_at)) Object.assign(prev, { latest: done, body });
    }
    const server = isServerEnvelope(test);
    for (const { first, firstBody, latest, body, platform, object_id, steps } of seen.values()) {
      const launched_at = server ? first.executed_at : latest.executed_at;
      const rawPrior = firstBody.expected_current_daily_budget_usd;
      const prior = typeof rawPrior === "number" && Number.isFinite(rawPrior) && rawPrior >= 0 ? rawPrior : null;
      out.push({
        decision_id: c.id,
        emitted_at: c.emitted_at,
        test,
        platform,
        channel_slug: latest.exec_class!.split(".")[0]!,
        exec_class: latest.exec_class!,
        object_id,
        card_id: latest.id,
        run_ids: runIds,
        body,
        launched_at,
        baseline_daily_usd: server ? prior : (test.baseline_daily_usd ?? null),
        ...(server ? { steps } : {}),
        ends_on: testEndsOn(c.emitted_at, test, launched_at),
        reverted: reverted.has(`${c.id}:${object_id}`),
        ...(baselineInvalid ? { baselineInvalid } : {}),
      });
    }
  }
  return out;
}

export function runningTestOn(tests: readonly BudgetTest[], platform: BudgetPlatform, objectId: string, runId: string | null, now: Date): BudgetTest | null {
  return (
    tests.find((t) => t.platform === platform && t.object_id === objectId && !t.reverted && now.getTime() < testEndsAt(t) && !(runId && t.run_ids.includes(runId))) ?? null
  );
}

function chunks<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += IN_CHUNK) out.push(xs.slice(i, i + IN_CHUNK));
  return out;
}

type Db = ReturnType<typeof tenantClient>;

async function readTestsFor(db: Db, tenant_id: string, cards: TestCard[], actionsIn?: TestAction[]): Promise<BudgetTest[]> {
  if (cards.length === 0) return [];
  const runs: TestRun[] = [];
  for (const part of chunks(cards.map((c) => c.id))) {
    const r = await db
      .from("agent_runs")
      .select("id, source_decision_id:payload->>source_decision_id")
      .eq("tenant_id", tenant_id)
      .in("payload->>source_decision_id", part)
      .limit(PAGE);
    if (r.error) throw new Error(`budget test runs: ${r.error.message}`);
    if ((r.data ?? []).length >= PAGE) throw new Error("budget test runs page full");
    runs.push(...((r.data ?? []) as TestRun[]));
  }
  let actions = actionsIn;
  if (!actions) {
    actions = [];
    for (const part of chunks(runs.map((r) => r.id))) {
      const a = await db
        .from("channel_actions")
        .select("id, run_id, exec_class, exec_status, executed_at, exec_payload, edited_body")
        .eq("tenant_id", tenant_id)
        .in("run_id", part)
        .in("exec_class", Object.keys(BUDGET_CLASSES))
        .eq("exec_status", "executed")
        .limit(PAGE);
      if (a.error) throw new Error(`budget test changes: ${a.error.message}`);
      if ((a.data ?? []).length >= PAGE) throw new Error("budget test changes page full");
      actions.push(...((a.data ?? []) as TestAction[]));
    }
  }
  const reverted = new Set<string>();
  for (const part of chunks(cards.map((c) => c.id))) {
    const v = await db
      .from("channel_actions")
      .select("body")
      .eq("tenant_id", tenant_id)
      .in(`body->>${TEST_REVERT_OF}`, part)
      .limit(PAGE);
    if (v.error) throw new Error(`budget test reverts: ${v.error.message}`);
    if ((v.data ?? []).length >= PAGE) throw new Error("budget test reverts page full");
    for (const row of (v.data ?? []) as Array<{ body: Record<string, unknown> | null }>) {
      const d = row.body?.[TEST_REVERT_OF];
      const o = row.body?.[TEST_REVERT_OBJECT];
      if (typeof d === "string" && typeof o === "string") reverted.add(`${d}:${o}`);
    }
  }
  return budgetTestsFrom(cards, runs, actions, reverted);
}

async function readCards(db: Db, tenant_id: string, ids: string[]): Promise<TestCard[]> {
  const out: TestCard[] = [];
  for (const part of chunks([...new Set(ids)])) {
    const r = await db.from("decisions").select("id, emitted_at, body").eq("tenant_id", tenant_id).eq("decision_class", CGO_CARD_CLASS).in("id", part).limit(PAGE);
    if (r.error) throw new Error(`budget test cards: ${r.error.message}`);
    out.push(...((r.data ?? []) as TestCard[]));
  }
  return out;
}

export async function loadBudgetTestFact(tenant_id: string, platform: BudgetPlatform, objectId: string, runId: string | null, now: Date): Promise<BudgetTestFact> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(objectId)) throw new Error("object id is not a plain id");
  const db = tenantClient(asTenantId(tenant_id));
  let baselineMissing = false;
  let testUnreadable = false;
  if (runId) {
    const r = await db.from("agent_runs").select("id, source_decision_id:payload->>source_decision_id").eq("tenant_id", tenant_id).eq("id", runId).limit(1);
    if (r.error) throw new Error(`budget test run: ${r.error.message}`);
    const src = ((r.data ?? []) as TestRun[])[0]?.source_decision_id;
    if (typeof src === "string" && src) {
      const card = (await readCards(db, tenant_id, [src]))[0];
      const read = card?.body?.dispatched_by === "cgo" ? parseBudgetTest(card.body.test) : { baselineInvalid: false, unreadable: false };
      if (read.unreadable) testUnreadable = true;
      else if (read.test && !isServerEnvelope(read.test) && (read.test.budget_usd ?? 0) > 0 && read.test.baseline_daily_usd == null) baselineMissing = true;
    }
  }
  const since = new Date(now.getTime() - LOOKBACK_DAYS * DAY).toISOString();
  const classes = Object.entries(BUDGET_CLASSES).filter(([, p]) => p === platform).map(([c]) => c);
  const namedBy = (col: string) => ["campaign_id", "ad_set_id", "object_id"].map((k) => `${col}->>${k}.eq.${objectId}`).join(",");
  const a = await db
    .from("channel_actions")
    .select("id, run_id, exec_class, exec_status, executed_at, exec_payload, edited_body")
    .eq("tenant_id", tenant_id)
    .in("exec_class", classes)
    .eq("exec_status", "executed")
    .gte("executed_at", since)
    .or(`${namedBy("exec_payload")},${namedBy("edited_body")}`)
    .limit(PAGE);
  if (a.error) throw new Error(`budget changes on the object: ${a.error.message}`);
  if ((a.data ?? []).length >= PAGE) throw new Error("budget changes page full");
  const actions = (a.data ?? []) as TestAction[];
  const runIds = [...new Set(actions.map((x) => x.run_id).filter((x): x is string => !!x))];
  if (runIds.length === 0) return { running: null, baselineMissing, ...(testUnreadable ? { testUnreadable } : {}) };
  const runs: TestRun[] = [];
  for (const part of chunks(runIds)) {
    const r = await db.from("agent_runs").select("id, source_decision_id:payload->>source_decision_id").eq("tenant_id", tenant_id).in("id", part).limit(PAGE);
    if (r.error) throw new Error(`budget test runs: ${r.error.message}`);
    runs.push(...((r.data ?? []) as TestRun[]));
  }
  const decisionIds = [...new Set(runs.map((r) => r.source_decision_id).filter((x): x is string => !!x))];
  if (decisionIds.length === 0) return { running: null, baselineMissing, ...(testUnreadable ? { testUnreadable } : {}) };
  const cards = await readCards(db, tenant_id, decisionIds);
  const tests = await readTestsFor(db, tenant_id, cards, actions);
  const t = runningTestOn(tests, platform, objectId, runId, now);
  return { running: t ? { decision_id: t.decision_id, ends_on: t.ends_on } : null, baselineMissing, ...(testUnreadable ? { testUnreadable } : {}) };
}

export async function readBudgetTests(tenant_id: string, now: Date): Promise<BudgetTest[]> {
  const db = tenantClient(asTenantId(tenant_id));
  const since = new Date(now.getTime() - MOVE_LOOKBACK_DAYS * DAY).toISOString();
  const r = await db
    .from("decisions")
    .select("id, emitted_at, body")
    .eq("tenant_id", tenant_id)
    .eq("decision_class", CGO_CARD_CLASS)
    .eq("body->>dispatched_by", "cgo")
    .not("body->test", "is", null)
    .gte("emitted_at", since)
    .limit(PAGE);
  if (r.error) throw new Error(`budget test cards: ${r.error.message}`);
  if ((r.data ?? []).length >= PAGE) throw new Error("budget test cards page full");
  return readTestsFor(db, tenant_id, (r.data ?? []) as TestCard[]);
}

export function extraSpendUsd(rows: ReadonlyArray<{ spend_date: string; amount_usd: number | string }>, baselineUsd: number, fromDay: string): number {
  let sum = 0;
  for (const r of rows) {
    if (r.spend_date < fromDay) continue;
    const v = Number(r.amount_usd);
    if (Number.isFinite(v)) sum += Math.max(0, v - baselineUsd);
  }
  return Math.round(sum * 100) / 100;
}

export function budgetTestStopUsd(t: Pick<BudgetTest, "test" | "body" | "launched_at" | "ends_on" | "baseline_daily_usd" | "steps">): number | null {
  const base = t.baseline_daily_usd;
  const daily = Number(t.body.daily_budget_usd);
  if (base == null || !(daily > base)) return null;
  if (isServerEnvelope(t.test)) {
    return t.steps?.length ? steppedRaiseStopUsd(base, t.steps, t.ends_on) : (raiseEnvelope({ daily_usd: daily, baseline_daily_usd: base, launched_at: t.launched_at, ends_on: t.ends_on })?.amount_usd ?? null);
  }
  return legacyTestTotalUsd(t.test);
}

export function testOver(t: BudgetTest, now: Date, extraUsd: number | null): { over: false } | { over: true; why: "ended" | "spent"; on: string; stop_usd?: number } {
  if (now.getTime() >= testEndsAt(t)) return { over: true, why: "ended", on: t.ends_on };
  const stop = budgetTestStopUsd(t);
  if (stop != null && extraUsd != null && extraUsd >= stop) return { over: true, why: "spent", on: now.toISOString().slice(0, 10), stop_usd: stop };
  return { over: false };
}

const cents = (n: number) => Math.round(n * 100);
const KEEP: Record<string, readonly string[]> = {
  meta_ads_adset: ["ad_set_id", "currency", "name", "about"],
  meta_ads_campaign: ["campaign_id", "currency", "name", "about"],
  google_ads: ["campaign_id", "name", "about"],
  tiktok_ads: ["advertiser_id", "advertiser_name", "object_id", "campaign_id", "ad_group_id", "ad_id", "name", "level"],
  chatgpt_ads: ["campaign_id", "name"],
};

export type RevertFresh = { chatgptUpdatedAt?: number | null; tiktokStatus?: string | null };

export function revertChange(t: BudgetTest, currentUsd: number, fresh: RevertFresh = {}): { exec_class: string; body: Record<string, unknown> } | null {
  const base = t.baseline_daily_usd;
  if (base == null || !(currentUsd > 0) || cents(base) === cents(currentUsd)) return null;
  const on = dayWords(t.ends_on);
  const rationale = `The budget test ${on ? `that ran until ${on} ` : ""}is over, so this puts the daily budget back to the $${base} it had before the test.`;
  const amounts = { daily_budget_usd: base, expected_current_daily_budget_usd: currentUsd };
  const pick = (keys: readonly string[]) => Object.fromEntries(keys.filter((k) => t.body[k] !== undefined).map((k) => [k, t.body[k]]));
  const exec_class = t.exec_class;
  if (t.platform === "meta") {
    const campaign = /update_campaign_budget/.test(exec_class);
    return { exec_class, body: { ...pick(campaign ? KEEP.meta_ads_campaign! : KEEP.meta_ads_adset!), ...amounts, rationale, over_cap: false } };
  }
  if (t.platform === "google") return { exec_class, body: { ...pick(KEEP.google_ads!), ...amounts, rationale, over_cap: false } };
  if (t.platform === "tiktok") {
    if (!fresh.tiktokStatus) return null;
    return { exec_class, body: { ...pick(KEEP.tiktok_ads!), ...amounts, expected_current_status: fresh.tiktokStatus, rationale, origin: "specialist" } };
  }
  if (fresh.chatgptUpdatedAt == null) return null;
  return {
    exec_class,
    body: { ...pick(KEEP.chatgpt_ads!), ...amounts, rationale, summary: "Put the budget back after its test", origin: "agent", expected_updated_at: fresh.chatgptUpdatedAt },
  };
}

async function revertBodyProblem(exec_class: string, body: Record<string, unknown>): Promise<string | null> {
  try {
    if (exec_class === "tiktok_ads.update_budget") {
      const { tiktokBudgetBody } = await import("@/services/connectors/tiktok-ads/held-schema");
      const r = tiktokBudgetBody.safeParse(body);
      return r.success ? null : r.error.issues.map((i) => i.message).join("; ").slice(0, 200);
    }
    const { orderBodyProblem } = await import("./cgo-order-validate");
    return orderBodyProblem(exec_class.replace(/_review$/, ""), body);
  } catch (e) {
    return (e as Error).message.slice(0, 200);
  }
}

export type MonitorDeps = {
  readTests: (tenant_id: string, now: Date) => Promise<BudgetTest[]>;
  readSpend: (tenant_id: string, t: BudgetTest, fromDay: string) => Promise<Array<{ spend_date: string; amount_usd: number | string }>>;
  liveBudget: (tenant_id: string, t: BudgetTest, now: Date) => Promise<number | null>;
  chatgptUpdatedAt: (tenant_id: string, t: BudgetTest) => Promise<number | null>;
  tiktokLive: (tenant_id: string, t: BudgetTest) => Promise<{ status: string; budget: number | null } | null>;
  file: (tenant_id: string, t: BudgetTest, change: { exec_class: string; body: Record<string, unknown> }, now: Date) => Promise<{ id: string; kept?: { same: boolean } }>;
  hold: (tenant_id: string, card: { id: string; run_id: string | null }, reason: string, now: Date) => Promise<boolean>;
  tell: (tenant_id: string, topic: string, ask: string, now: Date) => Promise<boolean>;
  log: (tenant_id: string, code: string, message: string) => void;
};

const headline = (t: BudgetTest, from: number, to: number) => {
  const name = typeof t.body.name === "string" && t.body.name.trim() ? `“${t.body.name.trim().slice(0, 80)}”` : `${t.platform} ${t.object_id}`;
  return { name, change: `from $${from} to $${to} a day` };
};

export async function monitorBudgetTests(tenant_id: string, now: Date = new Date(), deps: MonitorDeps = defaultMonitorDeps): Promise<{ filed: string[] }> {
  const filed: string[] = [];
  let tests: BudgetTest[];
  try {
    tests = await deps.readTests(tenant_id, now);
  } catch (e) {
    deps.log(tenant_id, "cgo.budget_test_read_failed", (e as Error).message);
    return { filed };
  }
  for (const t of tests) {
    if (t.reverted || now.getTime() > testEndsAt(t) + REVERT_GRACE_DAYS * DAY) continue;
    try {
      const base = t.baseline_daily_usd;
      let extra: number | null = null;
      if (base != null && now.getTime() < testEndsAt(t)) {
        extra = await deps
          .readSpend(tenant_id, t, dayOf(t.launched_at))
          .then((rows) => extraSpendUsd(rows, base, dayOf(t.launched_at)))
          .catch(() => null);
      }
      const over = testOver(t, now, extra);
      if (!over.over) continue;
      const topic = `test_revert:${t.decision_id}:${t.object_id}`;
      const set = Number(t.body.daily_budget_usd);
      if (base == null) {
        const h = headline(t, set, set);
        await deps.tell(tenant_id, topic, `The budget test on ${h.name} ended on ${dayWords(over.on) ?? over.on}. It was started without a usable baseline budget, so I did not file a change: put its budget back yourself if you want the old amount.`, now);
        continue;
      }
      const tk = t.platform === "tiktok" ? await deps.tiktokLive(tenant_id, t) : null;
      const live = t.platform === "tiktok" ? (tk?.budget ?? null) : await deps.liveBudget(tenant_id, t, now);
      const current = live ?? set;
      if (cents(current) === cents(base)) continue;
      const fresh: RevertFresh = t.platform === "chatgpt" ? { chatgptUpdatedAt: await deps.chatgptUpdatedAt(tenant_id, t) } : { tiktokStatus: tk?.status ?? null };
      const change = revertChange(t, current, fresh);
      const problem = change ? await revertBodyProblem(change.exec_class, change.body) : "no change could be built";
      const h = headline(t, current, base);
      if (!change || problem) {
        deps.log(tenant_id, "cgo.budget_test_revert_unfiled", `${t.decision_id} ${t.object_id}: ${problem}`);
        await deps.tell(tenant_id, topic, `The budget test on ${h.name} is over. I could not file the change to put it back ${h.change}, so please change it yourself.`, now);
        continue;
      }
      const res = await deps.file(tenant_id, t, change, now);
      if (res.kept) {
        await deps.tell(
          tenant_id,
          topic,
          res.kept.same
            ? `The budget test on ${h.name} is over. A card to put its daily budget back ${h.change} is already waiting for you; nothing changes until you approve it.`
            : `The budget test on ${h.name} is over. Another open card about it is waiting, so I did not file the change to put it back ${h.change}: decide that card, or change the budget yourself.`,
          now,
        );
        deps.log(tenant_id, "cgo.budget_test_revert_kept", `${t.decision_id} ${t.object_id} kept=${res.id} same=${res.kept.same}`);
        continue;
      }
      const id = res.id;
      filed.push(id);
      const reason = budgetTestRevertReason(over.on, base);
      await deps.hold(tenant_id, { id, run_id: null }, reason, now);
      const why = over.why === "spent" ? `spent its planned $${over.stop_usd} over the old budget` : `ended on ${dayWords(over.on) ?? over.on}`;
      await deps.tell(
        tenant_id,
        topic,
        `The budget test on ${h.name} ${why}. I filed a card to put its daily budget back ${h.change}; nothing changes until you approve it. The card is waiting for you.`,
        now,
      );
      deps.log(tenant_id, "cgo.budget_test_revert_filed", `${t.decision_id} ${t.object_id} card=${id} why=${over.why} words=${budgetTestWords(reason) ?? ""}`);
    } catch (e) {
      deps.log(tenant_id, "cgo.budget_test_revert_failed", `${t.decision_id} ${t.object_id}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  return { filed };
}

export const defaultMonitorDeps: MonitorDeps = {
  readTests: readBudgetTests,
  readSpend: async (tenant_id, t, fromDay) => {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("ad_spend_daily")
      .select("spend_date, amount_usd")
      .eq("tenant_id", tenant_id)
      .eq("platform", t.platform)
      .eq("source", "api")
      .eq("object_id", t.object_id)
      .gte("spend_date", fromDay)
      .limit(PAGE);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ spend_date: string; amount_usd: number | string }>;
  },
  liveBudget: async (tenant_id, t, now) => {
    try {
      const { data, error } = await tenantClient(asTenantId(tenant_id))
        .from("ad_campaigns")
        .select("budget_usd, budget_kind, currency, as_of")
        .eq("tenant_id", tenant_id)
        .eq("platform", t.platform)
        .eq("object_id", t.object_id)
        .limit(2);
      const rows = (data ?? []) as Array<{ budget_usd: number | string | null; budget_kind: string | null; currency: string | null; as_of: string | null }>;
      if (error || rows.length !== 1) return null;
      const r = rows[0]!;
      const age = now.getTime() - Date.parse(r.as_of ?? "");
      const usd = Number(r.budget_usd);
      return r.budget_kind === "daily" && r.currency === "USD" && age >= 0 && age <= FRESH_MS && usd > 0 ? usd : null;
    } catch {
      return null;
    }
  },
  chatgptUpdatedAt: async (tenant_id, t) => {
    try {
      const { readCampaignTree } = await import("@/services/connectors/chatgpt-ads/workspace");
      const { withChatgptBudgetCampaign } = await import("@/services/ads-wallet/chatgpt-budget-identity");
      const tree = await withChatgptBudgetCampaign(tenant_id, t.object_id, (id: string) => readCampaignTree(tenant_id, id));
      const u = Number((tree as { campaign?: { updated_at?: unknown } }).campaign?.updated_at);
      return Number.isInteger(u) ? u : null;
    } catch {
      return null;
    }
  },
  tiktokLive: async (tenant_id, t) => {
    try {
      const { tiktokAdsAccount } = await import("@/services/connectors/tiktok-ads/composio-read");
      const { readTiktokObject, isDailyMode } = await import("@/services/connectors/tiktok-ads/objects");
      const level = t.body.level === "ad_group" ? "ad_group" : "campaign";
      const live = await readTiktokObject(await tiktokAdsAccount(tenant_id), String(t.body.advertiser_id ?? ""), level, t.object_id);
      if (!live?.status) return null;
      return { status: live.status, budget: isDailyMode(live.budget_mode) && typeof live.budget === "number" ? live.budget : null };
    } catch {
      return null;
    }
  },
  file: async (tenant_id, t, change, now) => {
    const { ensureCgoOrderRun, orderActionType } = await import("./cgo-ad-orders");
    const { recordChannelExecAction } = await import("@/services/channels/exec-actions");
    const runId = await ensureCgoOrderRun(tenant_id, t.channel_slug as "meta_ads", now);
    const from = Number(change.body.expected_current_daily_budget_usd);
    const to = Number(change.body.daily_budget_usd);
    const h = headline(t, from, to);
    const title = `Put ${h.name} back to $${to} a day after its test`.slice(0, 300);
    let card: Record<string, unknown> = {};
    try {
      if (t.platform === "meta") card = (await import("@/services/tools/meta-ads/write/_exec-action")).buildMetaExecCardBody(change.exec_class, change.body).card;
      else if (t.platform === "google") card = (await import("@/services/tools/google-ads/write/_exec-action")).buildExecCardBody(change.exec_class, change.body).card;
    } catch {
      card = {};
    }
    const prose = String(change.body.rationale ?? title);
    const r = await recordChannelExecAction(
      {
        tenantId: tenant_id,
        runId,
        channelSlug: t.channel_slug,
        execClass: change.exec_class,
        execPayload: change.body,
        actionType: orderActionType(change.exec_class, change.body),
        title,
        body: {
          ...card,
          step: { evidence: [], ...((card.step as Record<string, unknown> | undefined) ?? {}), title, body: prose, blocking: false, effort: "minutes" },
          exact_change: (card.exact_change as unknown) ?? null,
          link: null,
          [TEST_REVERT_OF]: t.decision_id,
          [TEST_REVERT_OBJECT]: t.object_id,
        },
      },
      undefined,
      { enabled: () => false },
    );
    if (!r.kept) return { id: r.id };
    const { data } = await tenantClient(asTenantId(tenant_id)).from("channel_actions").select("body, exec_payload, edited_body").eq("tenant_id", tenant_id).eq("id", r.id).limit(1);
    const row = ((data ?? []) as Array<{ body: Record<string, unknown> | null; exec_payload: unknown; edited_body: unknown }>)[0];
    const amount = Number(((row?.edited_body ?? row?.exec_payload) as Record<string, unknown> | null)?.daily_budget_usd);
    const same = row?.body?.[TEST_REVERT_OF] === t.decision_id || (Number.isFinite(amount) && cents(amount) === cents(Number(change.body.daily_budget_usd)));
    return { id: r.id, kept: { same } };
  },
  hold: async (tenant_id, card, reason, now) => {
    const { recordCardHold } = await import("./unattended-policy");
    return recordCardHold(tenant_id, { table: "channel_actions", id: card.id, run_id: card.run_id }, { reasons: [reason] }, now);
  },
  tell: async (tenant_id, topic, ask, now) => {
    const { askFounderOutsideReview } = await import("./open-advice");
    return askFounderOutsideReview({ tenant_id, topic, ask, now });
  },
  log: (tenant_id, code, message) => {
    void import("@/services/logging/logEvent").then(({ logEvent }) => logEvent({ level: code.endsWith("_filed") ? "info" : "warn", source: "budget-tests", code, message: message.slice(0, 500), tenant_id })).catch(() => undefined);
  },
};
