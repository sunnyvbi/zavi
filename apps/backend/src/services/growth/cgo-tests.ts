import { z } from "zod";
import { CHANNELS } from "@zavi/shared";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { cgoReplyOf } from "./cgo-brief";
import type { CreatedObject } from "@/services/channels/created-object";

import { line, moveTestSchema, parseMoveTest, type MoveTest } from "./cgo-test-shape";
import { SERVER_ENVELOPE, testEndsOn } from "./test-envelope";
export { moveTestSchema, parseMoveTest, type MoveTest };

export const READOUT_MIN_DAYS = 2;
export const READOUT_MAX_DAYS = 30;
const DAY = 86_400_000;
const dayOf = (iso: string) => iso.slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

export function clampTest(t: MoveTest, today: string): MoveTest {
  const min = addDays(today, READOUT_MIN_DAYS);
  const max = addDays(today, READOUT_MAX_DAYS);
  const readout_on = t.readout_on < min ? min : t.readout_on > max ? max : t.readout_on;
  return { ...t, readout_on, envelope: SERVER_ENVELOPE };
}

export const VERDICTS = ["worked", "did_not_work", "not_measured"] as const;
export const readoutSchema = z.object({
  decision_id: z.string().uuid(),
  verdict: z.enum(VERDICTS),
  result: line(200),
  why: line(300).optional(),
});
export type Readout = z.infer<typeof readoutSchema>;

export type LaunchState = "launched" | "in_progress" | "blocked" | "never_ran";

export type DueTest = {
  decision_id: string;
  goal_id: string | null;
  hypothesis_id: string | null;
  agent: string;
  intent: string;
  test: MoveTest;
  state: Exclude<LaunchState, "in_progress">;
  why: string;
  launched_on: string | null;
};

export type TestCardRow = { id: string; status: string; emitted_at: string; body: Record<string, unknown> | null };
export type TestRunRow = { id: string; status: string; source_decision_id: string | null; cgo_reply?: unknown; finished_at?: string | null };
export type TestActionRow = {
  run_id: string;
  status: string;
  exec_class: string | null;
  exec_status: string | null;
  status_at: string | null;
  exec_payload?: unknown;
  exec_result?: unknown;
};
export type ActivationRow = { exec_class?: string | null; exec_payload: unknown; status_at: string | null };

export type ReceiptKind = "live" | "prepared" | "change" | "reduction" | "none";
const LIVE_ON_EXECUTE = new Set([
  "meta_ads.duplicate_ad_set",
  "meta_ads.duplicate_campaign",
  "meta_ads.create_ad",
  "meta_ads.launch_campaign",
  "x_ads.create_campaign",
  "chatgpt_ads.create_and_launch",
  "tiktok_ads.create_launch",
]);
const PREPARED_ON_EXECUTE = new Set([
  "meta_ads.create_ad_set", "meta_ads.create_custom_audience",
  "google_ads.create_campaign", "google_ads.create_ad_group", "google_ads.create_ad",
  "chatgpt_ads.create_campaign_bundle", "linkedin_ads.create_campaign_bundle", "generated_video.render.v1",
]);
const CHANGE_ON_EXECUTE = new Set([
  "meta_ads.update_ad_set_budget", "meta_ads.update_ad_set_budget_review", "meta_ads.replace_ad_set_geo_review",
  "google_ads.update_campaign_budget", "google_ads.update_campaign_budget_review", "google_ads.update_campaign",
  "chatgpt_ads.update_campaign_budget",
  "google_ads.update_ad_group", "google_ads.add_keywords", "google_ads.replace_geo_targets_review", "x_ads.update_campaign",
  "tiktok_ads.update_budget",
]);
const ON_STATUSES = new Set(["ACTIVE", "ENABLED"]);
const statusOf = (payload: unknown) => String(((payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>).status ?? "").toUpperCase();

export function receiptKind(a: Pick<TestActionRow, "exec_class" | "exec_payload">): ReceiptKind {
  const c = (a.exec_class ?? "").replace(/_review$/, "");
  if (!c) return "none";
  if (c === "x_ads.create_campaign") return (a.exec_payload as { launch?: string } | null)?.launch === "ACTIVE" ? "live" : "prepared";
  if (c === "x_ads.manage_objects") {
    const operation = (a.exec_payload as { request?: { operation?: string } } | null)?.request?.operation;
    if (operation === "create_ad_group") return "prepared";
    if (operation && /^(delete|remove)_/.test(operation)) return "reduction";
    return operation ? "change" : "none";
  }
  if (/\.set_status$/.test(c)) return ON_STATUSES.has(statusOf(a.exec_payload)) ? "live" : "reduction";
  if (/\.remove_resource$/.test(c)) return "reduction";
  if (LIVE_ON_EXECUTE.has(a.exec_class!) || LIVE_ON_EXECUTE.has(c)) return "live";
  if (PREPARED_ON_EXECUTE.has(a.exec_class!) || PREPARED_ON_EXECUTE.has(c)) return "prepared";
  if (CHANGE_ON_EXECUTE.has(a.exec_class!) || CHANGE_ON_EXECUTE.has(c)) return "change";
  return "none";
}

export function createdOf(a: Pick<TestActionRow, "exec_result">): CreatedObject | null {
  const r = (a.exec_result && typeof a.exec_result === "object" ? a.exec_result : {}) as Record<string, unknown>;
  const c = r.created as Partial<CreatedObject> | undefined;
  if (!c || (c.platform !== "meta" && c.platform !== "google" && c.platform !== "chatgpt" && c.platform !== "x") || typeof c.id !== "string" || !c.id) return null;
  if (!["campaign", "ad_set", "ad_group", "ad"].includes(String(c.object_type))) return null;
  return c as CreatedObject;
}

export function activationTarget(a: { exec_class?: string | null; exec_payload: unknown }): { platform: "meta" | "google" | "chatgpt" | "x"; object_type: CreatedObject["object_type"]; id: string } | null {
  const p = (a.exec_payload && typeof a.exec_payload === "object" ? a.exec_payload : {}) as Record<string, unknown>;
  const cls = a.exec_class ?? "";
  const s = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : null);
  if (cls === "x_ads.set_status") { const id = s(p.campaign_id); return id ? { platform: "x", object_type: "campaign", id } : null; }
  if (cls === "chatgpt_ads.set_status") { const id = s(p.campaign_id); return id ? { platform: "chatgpt", object_type: "campaign", id } : null; }
  if (cls.startsWith("meta_ads.")) {
    const id = s(p.object_id);
    const type = p.level === "adset" ? "ad_set" : p.level === "campaign" ? "campaign" : p.level === "ad" ? "ad" : null;
    return id && type ? { platform: "meta", object_type: type, id } : null;
  }
  if (cls.startsWith("google_ads.")) {
    const level = String(p.level ?? "campaign");
    if (level === "campaign") { const id = s(p.campaign_id); return id ? { platform: "google", object_type: "campaign", id } : null; }
    if (level === "ad_group") { const id = s(p.ad_group_id); return id ? { platform: "google", object_type: "ad_group", id } : null; }
    if (level === "ad") { const id = s(p.ad_id); return id ? { platform: "google", object_type: "ad", id } : null; }
  }
  return null;
}
const sameObject = (a: { platform: string; object_type: string; id: string }, b: { platform: string; object_type: string; id: string }) =>
  a.platform === b.platform && a.object_type === b.object_type && a.id === b.id;

const READ_OUT_STATUSES: string[] = ["approved", "acted", "dispatch_failed"];
const TERMINAL_FAIL = new Set(["parse_failed", "dispatch_error", "error", "failed", "cancelled"]);
const CARD_OPEN = new Set(["pending", "snoozed"]);
const CHANNEL_SLUGS: ReadonlySet<string> = new Set(CHANNELS.map((c) => c.slug));

export function launchStateOf(
  agent: string,
  runs: TestRunRow[],
  actions: TestActionRow[],
  activations?: ActivationRow[],
): { state: LaunchState; why: string; launched_at: string | null } {
  if (runs.length === 0) return { state: "never_ran", why: "no run started", launched_at: null };
  if (runs.some((r) => !TERMINAL_FAIL.has(r.status) && r.status !== "success")) return { state: "in_progress", why: "still running", launched_at: null };
  const ok = runs.filter((r) => r.status === "success");
  if (ok.length === 0) return { state: "blocked", why: `the run ended ${runs[0].status}`, launched_at: null };
  for (const r of ok) {
    const reply = cgoReplyOf({ cgo_reply: r.cgo_reply });
    if (reply?.status === "rejected") return { state: "blocked", why: `the specialist rejected it: ${reply.reason ?? "no reason"}`.slice(0, 200), launched_at: null };
    if (reply?.status === "input_required") return { state: "blocked", why: `the specialist needed an answer: ${reply.question ?? ""}`.slice(0, 200), launched_at: null };
  }
  const runIds = new Set(ok.map((r) => r.id));
  const ran = actions.filter((a) => runIds.has(a.run_id));
  const cards = ran.filter((a) => !isCutGuardOverride(a));
  const overridden = ran.some((a) => isCutGuardOverride(a) && a.exec_status === "executed");
  if (cards.length === 0) {
    if (overridden) return { state: "blocked", why: FOUNDER_PAUSED_WHY, launched_at: null };
    if (CHANNEL_SLUGS.has(agent)) return { state: "blocked", why: "the specialist filed no change", launched_at: null };
    const at = ok.map((r) => r.finished_at).filter((x): x is string => !!x).sort()[0] ?? null;
    return { state: "launched", why: "the work finished", launched_at: at };
  }
  const times: string[] = [];
  let prepared = 0;
  for (const a of cards) {
    if (!a.exec_class) {
      if (a.status === "acted" && a.status_at) times.push(a.status_at);
      continue;
    }
    if (a.exec_status !== "executed") continue;
    const kind = receiptKind(a);
    if (kind === "live") {
      const created = createdOf(a);
      if (created && !ON_STATUSES.has(created.status)) continue;
    }
    if ((kind === "live" || kind === "change") && a.status_at) times.push(a.status_at);
    if (kind === "prepared") {
      const created = createdOf(a);
      if (created?.activated_at && (created.status === "ENABLED" || created.status === "ACTIVE")) {
        times.push(created.activated_at);
        continue;
      }
      const on = created
        ? (activations ?? [])
            .filter((x) => { const t = activationTarget(x); return !!t && sameObject(t, created); })
            .map((x) => x.status_at)
            .filter((t): t is string => !!t && (!a.status_at || t >= a.status_at))
            .sort()[0]
        : undefined;
      if (on) times.push(on);
      else if (created?.status !== "UNVERIFIED") prepared++;
    }
  }
  if (times.length > 0) return { state: "launched", why: "the tested change went live", launched_at: times.sort()[0] };
  if (prepared > 0) return { state: "in_progress", why: "created paused, waiting for a separate activation", launched_at: null };
  if (cards.some((a) => CARD_OPEN.has(a.status) && a.exec_status !== "failed")) {
    return { state: "in_progress", why: "waiting on approval or execution", launched_at: null };
  }
  return { state: "blocked", why: overridden ? FOUNDER_PAUSED_WHY : "nothing it filed went live", launched_at: null };
}

const FOUNDER_PAUSED_WHY = "the founder paused it past Zavi's hold; that was their call, not a result of the test";

export function isCutGuardOverride(a: Pick<TestActionRow, "exec_class">): boolean {
  return a.exec_class === "meta_ads.pause_past_cut_guard";
}

export function dueTestsFrom(cards: TestCardRow[], runs: TestRunRow[], actions: TestActionRow[], today: string, activations: ActivationRow[] = []): DueTest[] {
  const out: DueTest[] = [];
  for (const c of cards) {
    const b = c.body ?? {};
    if (b.dispatched_by !== "cgo" || b.test_readout) continue;
    if (!READ_OUT_STATUSES.includes(c.status)) continue;
    const test = parseMoveTest(b.test);
    if (!test || test.readout_on > today) continue;
    const agent = String(b.target_agent_slug ?? "");
    const ls = launchStateOf(agent, runs.filter((r) => r.source_decision_id === c.id), actions, activations);
    if (ls.state === "in_progress") continue;
    if (ls.state === "launched" && ls.launched_at && readoutDay(c.emitted_at, test, ls.launched_at) > today) continue;
    out.push({
      decision_id: c.id,
      goal_id: typeof b.goal_id === "string" ? b.goal_id : null,
      hypothesis_id: typeof b.hypothesis_id === "string" ? b.hypothesis_id : null,
      agent,
      intent: String(b.intent ?? "").replace(/\s+/g, " ").slice(0, 160),
      test,
      state: ls.state,
      why: ls.why,
      launched_on: ls.launched_at ? dayOf(ls.launched_at) : null,
    });
  }
  return out;
}

export function readoutDay(emittedAt: string, test: Pick<MoveTest, "readout_on">, launchedAt: string | null): string {
  return launchedAt ? testEndsOn(emittedAt, test, launchedAt) : test.readout_on;
}

export const DUE_LOOKBACK_DAYS = 90;
export const DUE_MAX = 10;
const PAGE = 50;
const PAGES_MAX = 4;

const IN_CHUNK = 100;
const ROW_PAGE = 1000;
function inChunks<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += IN_CHUNK) out.push(xs.slice(i, i + IN_CHUNK));
  return out;
}

async function readLaunchEvidence(
  tenant_id: string,
  cards: ReadonlyArray<Pick<TestCardRow, "id" | "emitted_at">>,
): Promise<{ runs: TestRunRow[]; actions: TestActionRow[]; activations: ActivationRow[] }> {
  const db = tenantClient(asTenantId(tenant_id));
  const ids = cards.map((c) => c.id);
  if (ids.length === 0) return { runs: [], actions: [], activations: [] };
  const runs: TestRunRow[] = [];
  for (const part of inChunks(ids)) {
    for (let from = 0; ; from += ROW_PAGE) {
      const runsR = await db
        .from("agent_runs")
        .select("id, status, finished_at, source_decision_id:payload->>source_decision_id, cgo_reply:parsed->cgo_reply")
        .eq("tenant_id", tenant_id)
        .in("payload->>source_decision_id", part)
        .order("id", { ascending: true })
        .range(from, from + ROW_PAGE - 1);
      if (runsR.error) throw new Error(`due test runs: ${runsR.error.message}`);
      const page = (runsR.data ?? []) as TestRunRow[];
      runs.push(...page);
      if (page.length < ROW_PAGE) break;
    }
  }
  const actions: TestActionRow[] = [];
  for (const part of inChunks(runs.map((r) => r.id))) {
    for (let from = 0; ; from += ROW_PAGE) {
      const a = await db
        .from("channel_actions")
        .select("id, run_id, status, exec_class, exec_status, status_at, exec_payload, exec_result")
        .eq("tenant_id", tenant_id)
        .in("run_id", part)
        .order("id", { ascending: true })
        .range(from, from + ROW_PAGE - 1);
      if (a.error) throw new Error(`due test cards: ${a.error.message}`);
      const page = (a.data ?? []) as TestActionRow[];
      actions.push(...page);
      if (page.length < ROW_PAGE) break;
    }
  }
  let activations: ActivationRow[] = [];
  if (actions.some((a) => a.exec_status === "executed" && receiptKind(a) === "prepared")) {
    const since = cards.map((c) => c.emitted_at).sort()[0];
    const all: ActivationRow[] = [];
    for (let from = 0; ; from += ROW_PAGE) {
      const v = await db
        .from("channel_actions")
        .select("id, exec_class, exec_payload, status_at")
        .eq("tenant_id", tenant_id)
        .eq("exec_status", "executed")
        .like("exec_class", "%.set_status%")
        .gte("status_at", since)
        .order("id", { ascending: true })
        .range(from, from + ROW_PAGE - 1);
      if (v.error) throw new Error(`due test activations: ${v.error.message}`);
      const page = (v.data ?? []) as ActivationRow[];
      all.push(...page);
      if (page.length < ROW_PAGE) break;
    }
    activations = all.filter((x) => receiptKind({ exec_class: x.exec_class ?? null, exec_payload: x.exec_payload }) === "live");
  }
  return { runs, actions, activations };
}

export async function readMoveLaunches(tenant_id: string, moves: TestCardRow[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (moves.length === 0) return out;
  const { runs, actions, activations } = await readLaunchEvidence(tenant_id, moves);
  for (const m of moves) {
    const agent = String(m.body?.target_agent_slug ?? "");
    const ls = launchStateOf(agent, runs.filter((r) => r.source_decision_id === m.id), actions, activations);
    out.set(m.id, ls.state === "launched" ? ls.launched_at : null);
  }
  return out;
}

export async function readDueTests(tenant_id: string, cardClass: string, now: Date): Promise<{ due: DueTest[]; more: number }> {
  const db = tenantClient(asTenantId(tenant_id));
  const today = now.toISOString().slice(0, 10);
  const due: DueTest[] = [];
  let more = 0;
  for (let page = 0; page < PAGES_MAX; page++) {
    const { data, error } = await db
      .from("decisions")
      .select("id, status, emitted_at, body")
      .eq("tenant_id", tenant_id)
      .eq("decision_class", cardClass)
      .eq("body->>dispatched_by", "cgo")
      .in("status", READ_OUT_STATUSES)
      .not("body->test", "is", null)
      .is("body->test_readout", null)
      .lte("body->test->>readout_on", today)
      .gte("body->test->>readout_on", addDays(today, -DUE_LOOKBACK_DAYS))
      .order("body->test->>readout_on", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`due tests: ${error.message}`);
    const cards = (data ?? []) as TestCardRow[];
    if (cards.length === 0) break;
    const { runs, actions, activations } = await readLaunchEvidence(tenant_id, cards);
    for (const d of dueTestsFrom(cards, runs, actions, today, activations)) {
      if (due.length < DUE_MAX) due.push(d);
      else more++;
    }
    if (cards.length < PAGE) break;
  }
  return { due, more };
}

export function readoutFinding(due: Pick<DueTest, "hypothesis_id" | "test">, r: Pick<Readout, "verdict" | "result">): { hypothesis: string; finding: string } | null {
  if (!due.hypothesis_id) return null;
  const verdict = r.verdict === "worked" ? "WORKED" : r.verdict === "did_not_work" ? "DID NOT WORK" : "NOT MEASURED";
  return {
    hypothesis: due.hypothesis_id,
    finding: `Test readout (${due.test.variable}; success if ${due.test.success_if}): ${verdict}. ${r.result}`.slice(0, 500),
  };
}

export function honestReadout(due: DueTest, r: Readout): Readout {
  if (due.state !== "launched") {
    return { ...r, verdict: "not_measured", result: `Not launched (${due.why}); nothing was tested. ${r.result}`.slice(0, 200) };
  }
  if (r.verdict !== "not_measured" && !/\d/.test(r.result)) {
    return { ...r, verdict: "not_measured", result: `No measured number was given. ${r.result}`.slice(0, 200) };
  }
  return r;
}

export type SavedFinding = { decision_id: string; hypothesis: string; finding: string };

export async function applyReadouts(args: {
  tenant_id: string;
  run_id: string;
  readouts: unknown;
  due: DueTest[];
  cardClass: string;
  now: Date;
}): Promise<{ saved: number; findings: SavedFinding[] }> {
  const list = Array.isArray(args.readouts) ? args.readouts : [];
  const dueById = new Map(args.due.map((d) => [d.decision_id, d]));
  const db = tenantClient(asTenantId(args.tenant_id));
  const findings: SavedFinding[] = [];
  let saved = 0;
  for (const raw of list.slice(0, DUE_MAX)) {
    const p = readoutSchema.safeParse(raw);
    if (!p.success) continue;
    const due = dueById.get(p.data.decision_id);
    if (!due) continue;
    dueById.delete(p.data.decision_id);
    const r = honestReadout(due, p.data);
    const f = readoutFinding(due, r);
    try {
      const { data: row, error: readErr } = await db
        .from("decisions")
        .select("body")
        .eq("id", due.decision_id)
        .eq("tenant_id", args.tenant_id)
        .eq("decision_class", args.cardClass)
        .maybeSingle();
      const body = (row as { body?: Record<string, unknown> } | null)?.body;
      if (readErr || !body || body.test_readout) continue;
      const readout = { ...r, read_at: args.now.toISOString(), run_id: args.run_id, launched_on: due.launched_on, ...(f ? { finding: f.finding, hypothesis_id: f.hypothesis, delivered: false } : {}) };
      const { data: updated, error } = await db
        .from("decisions")
        .update({ body: { ...body, test_readout: readout } })
        .eq("id", due.decision_id)
        .eq("tenant_id", args.tenant_id)
        .is("body->test_readout", null)
        .select("id");
      if (error || !Array.isArray(updated) || updated.length === 0) continue;
      saved++;
      if (f) findings.push({ decision_id: due.decision_id, ...f });
    } catch {
    }
  }
  return { saved, findings };
}

export async function readUndeliveredFindings(tenant_id: string, cardClass: string): Promise<SavedFinding[]> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data, error } = await db
    .from("decisions")
    .select("id, body")
    .eq("tenant_id", tenant_id)
    .eq("decision_class", cardClass)
    .eq("body->test_readout->>delivered", "false")
    .limit(DUE_MAX);
  if (error) throw new Error(`undelivered findings: ${error.message}`);
  const out: SavedFinding[] = [];
  for (const c of (data ?? []) as Array<{ id: string; body: Record<string, unknown> | null }>) {
    const t = (c.body?.test_readout ?? null) as { finding?: unknown; hypothesis_id?: unknown } | null;
    if (typeof t?.finding === "string" && typeof t?.hypothesis_id === "string") out.push({ decision_id: c.id, hypothesis: t.hypothesis_id, finding: t.finding });
  }
  return out;
}

export async function markFindingsDelivered(tenant_id: string, cardClass: string, decisionIds: string[]): Promise<void> {
  const db = tenantClient(asTenantId(tenant_id));
  for (const id of decisionIds) {
    try {
      const { data: row } = await db.from("decisions").select("body").eq("id", id).eq("tenant_id", tenant_id).eq("decision_class", cardClass).maybeSingle();
      const body = (row as { body?: Record<string, unknown> } | null)?.body;
      const t = body?.test_readout as Record<string, unknown> | undefined;
      if (!body || !t || t.delivered !== false) continue;
      await db
        .from("decisions")
        .update({ body: { ...body, test_readout: { ...t, delivered: true } } })
        .eq("id", id)
        .eq("tenant_id", tenant_id)
        .eq("body->test_readout->>delivered", "false");
    } catch {
    }
  }
}

export type TestsSummaryItem = {
  decision_id: string;
  channel_slug: string | null;
  title: string;
  verdict: (typeof VERDICTS)[number] | null;
  launch: LaunchState;
  read_on: string | null;
};

export type TestsSummary = {
  won: number;
  lost: number;
  never_launched: number;
  running: number;
  next_read_on: string | null;
  items: TestsSummaryItem[];
};

export function summarizeTests(
  cards: TestCardRow[],
  evidence: { runs: TestRunRow[]; actions: TestActionRow[]; activations: ActivationRow[] },
  now: Date,
  days: number,
): TestsSummary {
  const today = dayOf(now.toISOString());
  const since = addDays(today, -days);
  const out: TestsSummary = { won: 0, lost: 0, never_launched: 0, running: 0, next_read_on: null, items: [] };
  for (const c of cards) {
    const b = c.body ?? {};
    if (b.dispatched_by !== "cgo" || !READ_OUT_STATUSES.includes(c.status)) continue;
    const test = parseMoveTest(b.test);
    if (!test) continue;
    const readout = (b.test_readout && typeof b.test_readout === "object" ? b.test_readout : null) as
      | { verdict?: unknown; read_at?: unknown; launched_on?: unknown }
      | null;
    const readAt = typeof readout?.read_at === "string" ? dayOf(readout.read_at) : null;
    if (dayOf(c.emitted_at) < since && !(readAt && readAt >= since)) continue;
    const agent = String(b.target_agent_slug ?? "");
    const ls = launchStateOf(agent, evidence.runs.filter((r) => r.source_decision_id === c.id), evidence.actions, evidence.activations);
    const verdict = readout && (VERDICTS as readonly string[]).includes(String(readout.verdict)) ? (readout.verdict as TestsSummaryItem["verdict"]) : null;
    const launch: LaunchState = !readout ? ls.state : typeof readout.launched_on === "string" ? "launched" : ls.state === "blocked" ? "blocked" : "never_ran";
    const read_on = readout ? readAt : readoutDay(c.emitted_at, test, ls.launched_at);
    out.items.push({
      decision_id: c.id,
      channel_slug: CHANNEL_SLUGS.has(agent) ? agent : null,
      title: String(b.intent ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
      verdict,
      launch,
      read_on,
    });
    if (verdict === "worked") out.won++;
    else if (verdict === "did_not_work") out.lost++;
    else if (readout || ((launch === "blocked" || launch === "never_ran") && (read_on ?? today) <= today)) {
      if (launch !== "launched") out.never_launched++;
    } else {
      out.running++;
      if (read_on && (!out.next_read_on || read_on < out.next_read_on)) out.next_read_on = read_on;
    }
  }
  return out;
}

export async function readTestsSummary(tenant_id: string, cardClass: string, now: Date, days: number): Promise<TestsSummary> {
  const db = tenantClient(asTenantId(tenant_id));
  const from = new Date(now.getTime() - (days + READOUT_MAX_DAYS + DUE_LOOKBACK_DAYS) * DAY).toISOString();
  const { data, error } = await db
    .from("decisions")
    .select("id, status, emitted_at, body")
    .eq("tenant_id", tenant_id)
    .eq("decision_class", cardClass)
    .eq("body->>dispatched_by", "cgo")
    .in("status", READ_OUT_STATUSES)
    .not("body->test", "is", null)
    .gte("emitted_at", from)
    .order("emitted_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`tests summary: ${error.message}`);
  const cards = (data ?? []) as TestCardRow[];
  return summarizeTests(cards, await readLaunchEvidence(tenant_id, cards), now, days);
}
