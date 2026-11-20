
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { alert } from "@/services/logging/alert";
import { loadChatCardEvents, loadIdsWithChatCard, loadRunTriggers, type ChatCardEvent } from "./approval-slack-notify";
import { chatCardEventId, founderAdviceEventId } from "@/services/approvals/chat-card-delivery";
import { GROWTH_PAGE_ONLY_NOT_IN } from "@/services/approvals/growth-page-only";

const STRAND_MIN_AGE_MS = 10 * 60 * 1000;

const NEW_ALERT_MIN = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;
function adminHumanActions(): string {
  return `${(process.env.ADMIN_ORIGIN || "https://admin.zaviagent.com").replace(/\/$/, "")}/human-actions`;
}
const MAX_TENANT_ROWS = 8;

let lastPagedBucket: string | null = null;

export function __resetStrandPageMemoForTest(): void {
  lastPagedBucket = null;
}

type StrandedRow = {
  id?: string;
  tenant_id: string;
  agent_run_id: string | null;
  emitted_at: string | null;
  decision_class?: string | null;
};

export type TenantMeta = { id: string; slug: string | null; kind: string | null };

export type StrandTenantLine = {
  tenant_id: string;
  slug: string;
  linkKey: string;
  isTest: boolean;
  count: number;
  new24h: number;
  newlyAged: number;
  over7d: number;
  oldestDays: number;
  dominantClass: string;
};

export type StrandReport = {
  stranded: number;
  tenants: number;
  realStranded: number;
  realTenants: number;
  testStranded: number;
  testTenants: number;
  newLast24h: number;
  newlyAged7d: number;
  over7d: number;
  oldestDays: number;
  lines: StrandTenantLine[];
};

export type StrandProbeResult = StrandReport;

function safeClassSlug(raw: string | null | undefined): string {
  const cleaned = (raw ?? "").toLowerCase().replace(/[^a-z0-9._:-]/g, "").slice(0, 60);
  return cleaned.length > 0 ? cleaned : "(unclassified)";
}

export function buildStrandReport(
  rows: StrandedRow[],
  tenantMeta: Map<string, TenantMeta>,
  nowMs: number,
): StrandReport {
  type Acc = {
    count: number;
    new24h: number;
    newlyAged: number;
    over7d: number;
    oldestMs: number;
    classes: Map<string, number>;
  };
  const per = new Map<string, Acc>();
  const dayAgo = nowMs - DAY_MS;
  const sevenDaysAgo = nowMs - SEVEN_DAYS_MS;
  const eightDaysAgo = nowMs - SEVEN_DAYS_MS - DAY_MS;

  for (const r of rows) {
    const emittedMs = Date.parse(r.emitted_at ?? "");
    if (Number.isNaN(emittedMs)) continue;
    const acc = per.get(r.tenant_id) ?? {
      count: 0,
      new24h: 0,
      newlyAged: 0,
      over7d: 0,
      oldestMs: emittedMs,
      classes: new Map<string, number>(),
    };
    acc.count++;
    if (emittedMs > dayAgo) acc.new24h++;
    if (emittedMs < sevenDaysAgo) acc.over7d++;
    if (emittedMs < sevenDaysAgo && emittedMs >= eightDaysAgo) acc.newlyAged++;
    acc.oldestMs = Math.min(acc.oldestMs, emittedMs);
    const cls = safeClassSlug(r.decision_class);
    acc.classes.set(cls, (acc.classes.get(cls) ?? 0) + 1);
    per.set(r.tenant_id, acc);
  }

  const lines: StrandTenantLine[] = [...per.entries()].map(([tenant_id, a]) => {
    const meta = tenantMeta.get(tenant_id);
    let dominantClass = "(unclassified)";
    let best = -1;
    for (const [cls, n] of a.classes) {
      if (n > best) {
        best = n;
        dominantClass = cls;
      }
    }
    return {
      tenant_id,
      slug: meta?.slug ?? tenant_id.slice(0, 8),
      linkKey: meta?.slug ?? tenant_id,
      isTest: meta?.kind === "test",
      count: a.count,
      new24h: a.new24h,
      newlyAged: a.newlyAged,
      over7d: a.over7d,
      oldestDays: Math.round(((nowMs - a.oldestMs) / DAY_MS) * 10) / 10,
      dominantClass,
    };
  });

  const real = lines.filter((l) => !l.isTest).sort((a, b) => b.count - a.count || b.oldestDays - a.oldestDays);
  const test = lines.filter((l) => l.isTest);
  const sum = (xs: StrandTenantLine[], f: (l: StrandTenantLine) => number) =>
    xs.reduce((acc, l) => acc + f(l), 0);

  return {
    stranded: sum(lines, (l) => l.count),
    tenants: lines.length,
    realStranded: sum(real, (l) => l.count),
    realTenants: real.length,
    testStranded: sum(test, (l) => l.count),
    testTenants: test.length,
    newLast24h: sum(real, (l) => l.new24h),
    newlyAged7d: sum(real, (l) => l.newlyAged),
    over7d: sum(real, (l) => l.over7d),
    oldestDays: real.reduce((m, l) => Math.max(m, l.oldestDays), 0),
    lines: real,
  };
}

export function shouldPageStrand(
  report: StrandReport,
  nowMs: number,
): { page: boolean; dedupeKey: string; reason: "delta" | "floor" | "none" } {
  if (report.newLast24h >= NEW_ALERT_MIN || report.newlyAged7d > 0) {
    return {
      page: true,
      dedupeKey: `approval_stranded:delta:${Math.floor(nowMs / DAY_MS)}`,
      reason: "delta",
    };
  }
  if (report.realStranded > 0) {
    return {
      page: true,
      dedupeKey: `approval_stranded:floor:${Math.floor(nowMs / WEEK_MS)}`,
      reason: "floor",
    };
  }
  return { page: false, dedupeKey: "", reason: "none" };
}

export function renderStrandPage(
  report: StrandReport,
  reason: "delta" | "floor",
): { msg: string; detail: string; subjectDetail: string } {
  const shown = report.lines.slice(0, MAX_TENANT_ROWS);
  const rest = report.lines.slice(MAX_TENANT_ROWS);

  const headline =
    reason === "delta"
      ? `${report.newLast24h} new stranded approval(s) in the last 24h` +
        (report.newlyAged7d > 0 ? `, ${report.newlyAged7d} just crossed 7 days unactioned` : "") +
        `. Standing backlog: ${report.realStranded} across ${report.realTenants} customer tenant(s).`
      : `Weekly reminder: ${report.realStranded} approval(s) across ${report.realTenants} customer tenant(s) are still stranded (nothing new this week; oldest ${report.oldestDays}d).`;

  const msg =
    `${headline} The Slack push never landed (no #zavi channel, no owner DM, or the post failed) — ` +
    `the cards are NOT lost, they are still live in each tenant's workspace approvals tab. Nobody was NOTIFIED. ` +
    `Per-tenant breakdown and admin links are in the email body.`;

  const col = (s: string, w: number) => s.padEnd(w).slice(0, w);
  const table = [
    `${col("tenant", 42)} ${col("new24h", 7)} ${col("total", 6)} ${col("oldest", 8)} mostly`,
    ...shown.map(
      (l) =>
        `${col(l.slug, 42)} ${col(String(l.new24h), 7)} ${col(String(l.count), 6)} ${col(
          `${l.oldestDays}d`,
          8,
        )} ${l.dominantClass}`,
    ),
  ];
  if (rest.length > 0) {
    const restCount = rest.reduce((a, l) => a + l.count, 0);
    table.push(
      `… +${rest.length} more tenant(s), ${restCount} approval(s): ${rest.map((l) => l.slug).join(", ")}`,
    );
  }

  const detail = [
    "WHAT THIS MEANS",
    "  An approval card was created for a customer and the Slack push never landed.",
    "  The decision is not lost — it is still live in that tenant's workspace",
    "  approvals tab. What failed is the NOTIFICATION, so nobody knows to go look.",
    "",
    "HOW TO CLEAR ONE",
    "  Open admin Human Actions for the tenant and approve/reject in place.",
    ...shown.map(
      (l) => `  ${l.slug}: ${adminHumanActions()}?tenant=${encodeURIComponent(l.linkKey)}`,
    ),
    "",
    `CUSTOMER TENANTS (${report.realStranded} stranded across ${report.realTenants})`,
    ...table.map((t) => `  ${t}`),
    "",
    "AGE",
    `  ${report.over7d} of these ${report.over7d === 1 ? "is" : "are"} already older than 7 days; oldest is ${report.oldestDays}d.`,
    "  Rows past 7 days that are still proposed were held back from the auto-expiry",
    "  sweep (it withholds security/money-critical decisions), so they will not age",
    "  out on their own — they clear only when a human acts.",
    ...(report.testStranded > 0
      ? [
          "",
          `IGNORED: ${report.testStranded} more on ${report.testTenants} test tenant(s) — measured in praxis_logs, not counted above.`,
        ]
      : []),
  ].join("\n");

  const subjectDetail =
    reason === "delta"
      ? `${report.newLast24h} new · ${report.realStranded} backlog`
      : `weekly · ${report.realStranded} backlog`;

  return { msg, detail, subjectDetail };
}

async function loadTenantMeta(tenantIds: string[]): Promise<Map<string, TenantMeta>> {
  const map = new Map<string, TenantMeta>();
  if (tenantIds.length === 0) return map;
  try {
    const { data, error } = await serviceClient()
      .from("tenants")
      .select("id, slug, kind")
      .in("id", tenantIds);
    if (error) {
      console.warn(
        `[approval-strand-probe] tenant lookup errored (page degrades to ids, test tenants not excluded): ${error.message}`,
      );
      return map;
    }
    for (const t of (data ?? []) as TenantMeta[]) map.set(t.id, t);
  } catch (e) {
    console.warn(
      `[approval-strand-probe] tenant lookup failed (page degrades to ids): ${(e as Error).message}`,
    );
  }
  return map;
}

export async function probeStrandedApprovals(
  nowMs: number = Date.now(),
): Promise<StrandProbeResult> {
  const svc = serviceClient();
  const { data, error } = await svc
    .from("decisions")
    .select("id, tenant_id, agent_run_id, emitted_at, decision_class")
    .eq("status", "proposed")
    .eq("autonomy_at_emit", "approval")
    .is("slack_approval_posted_at", null)
    .is("slack_push_suppressed_at", null)
    .not("decision_class", "in", GROWTH_PAGE_ONLY_NOT_IN);

  if (error) throw new Error(`approval-strand-probe scan failed: ${error.message}`);

  const rows = (data ?? []) as StrandedRow[];
  const cutoff = nowMs - STRAND_MIN_AGE_MS;

  const runIds = [...new Set(rows.map((r) => r.agent_run_id).filter((x): x is string => !!x))];
  const triggers = await loadRunTriggers(runIds);
  const triggerOf = (r: StrandedRow) => (r.agent_run_id ? triggers.get(r.agent_run_id) : undefined);
  const chatRows = rows.filter((r): r is StrandedRow & { id: string } => triggerOf(r) === "chat" && !!r.id);
  const withCard = await loadIdsWithChatCard(chatRows);

  const stranded: StrandedRow[] = [];
  for (const r of rows) {
    const t = triggerOf(r);
    if (t === "channel_recipe") continue;
    if (t === "chat" && (withCard === null || (!!r.id && withCard.has(r.id)))) continue;
    if (!r.emitted_at) continue;
    const emittedMs = Date.parse(r.emitted_at);
    if (Number.isNaN(emittedMs) || emittedMs > cutoff) continue;
    stranded.push(r);
  }

  const tenantMeta = await loadTenantMeta([...new Set(stranded.map((r) => r.tenant_id))]);
  const report = buildStrandReport(stranded, tenantMeta, nowMs);

  const allLines = new Map<string, number>();
  for (const r of stranded) allLines.set(r.tenant_id, (allLines.get(r.tenant_id) ?? 0) + 1);
  for (const [tenant_id, count] of allLines) {
    await logEvent({
      level: "warn",
      source: "approval_strand",
      code: "approval.stranded",
      message: "approval decisions stranded (no Slack target, past grace window)",
      tenant_id,
      meta: { count },
    });
  }

  const decision = shouldPageStrand(report, nowMs);
  if (decision.page && decision.reason !== "none" && decision.dedupeKey !== lastPagedBucket) {
    lastPagedBucket = decision.dedupeKey;
    const { msg, detail, subjectDetail } = renderStrandPage(report, decision.reason);
    await alert({
      source: "approval-strand-probe",
      code: "approval_stranded",
      msg,
      email: { dedupeKey: decision.dedupeKey, detail, subjectDetail },
    });
  }

  return report;
}

const RECONCILE_MIN_AGE_MS = 15 * 60 * 1000;
const RECONCILE_WINDOW_MS = 7 * DAY_MS;
const AD_CLASS_RE = "^(meta_ads|google_ads)\\.";

type ReconcileRow = { id: string; tenant_id: string; run_id: string | null; table: "decisions" | "channel_actions"; founder: boolean; advice_missing: boolean };

export type ReconcileRun = { trigger: string; thread_id: string | null };

export type ChatCardReconcileResult = { scanned: number; missing: number; resent: number; advice_resent: number; skipped?: "card_lookup_failed" | "scan_failed" };

type SendFn = (events: Array<{ id: string; name: string; data: Record<string, unknown> }>) => Promise<unknown>;

const RECONCILE_PAGE = 500;
const RECONCILE_MAX_PAGES = 200;

export function planChatCardReconcile(
  rows: ReconcileRow[],
  runs: Map<string, ReconcileRun>,
  cards: ChatCardEvent[],
): { deliver: ReconcileRow[]; advice: ReconcileRow[] } {
  const inThread = new Set(cards.filter((c) => c.full).map((c) => `${c.tenant_id}|${c.thread_id ?? ""}|${c.decision_id}`));
  const deliver: ReconcileRow[] = [];
  const advice: ReconcileRow[] = [];
  for (const r of rows) {
    if (!r.run_id) continue;
    const run = runs.get(r.run_id);
    const chatOrigin = run?.trigger === "chat" || (run?.trigger === "handoff" && r.founder);
    if (chatOrigin && !(run!.thread_id && inThread.has(`${r.tenant_id}|${run!.thread_id}|${r.id}`))) deliver.push(r);
    if (r.table === "decisions" && r.founder && r.advice_missing) advice.push(r);
  }
  return { deliver, advice };
}

type PageResult<T> = { data: T[] | null; error: { message: string } | null };
type Cursor = { at: string; id: string } | null;

export async function walkKeyset<T extends { id: string }>(
  page: (after: Cursor) => PromiseLike<PageResult<T>>,
  atOf: (row: T) => string,
): Promise<T[] | null> {
  const out: T[] = [];
  let after: Cursor = null;
  for (let p = 0; p < RECONCILE_MAX_PAGES; p++) {
    const { data, error } = await page(after);
    if (error) {
      console.warn(`[approval-strand-probe] chat-card reconcile scan failed: ${error.message}`);
      return null;
    }
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < RECONCILE_PAGE) return out;
    const last = rows[rows.length - 1];
    after = { at: atOf(last), id: last.id };
  }
  void logEvent({ level: "error", source: "approval_strand", code: "approval.chat_card_reconcile_capped", message: `chat-card reconcile stopped at ${RECONCILE_MAX_PAGES * RECONCILE_PAGE} rows`, meta: { count: out.length } });
  return out;
}

const afterCursor = (col: string, c: NonNullable<Cursor>) => `${col}.gt.${c.at},and(${col}.eq.${c.at},id.gt.${c.id})`;

export async function reconcileChatCards(nowMs: number = Date.now(), send?: SendFn): Promise<ChatCardReconcileResult> {
  const svc = serviceClient();
  const since = new Date(nowMs - RECONCILE_WINDOW_MS).toISOString();
  const until = new Date(nowMs - RECONCILE_MIN_AGE_MS).toISOString();
  type DecRow = { id: string; tenant_id: string; agent_run_id: string | null; emitted_at: string; founder_chat_order: string | null; founder_advice: unknown };
  type ChRow = { id: string; tenant_id: string; run_id: string | null; proposed_at: string };
  const [dec, ch] = await Promise.all([
    walkKeyset<DecRow>((after) => {
      let q = svc
        .from("decisions")
        .select("id, tenant_id, agent_run_id, emitted_at, founder_chat_order:body->>founder_chat_order, founder_advice")
        .eq("status", "proposed")
        .eq("autonomy_at_emit", "approval")
        .filter("decision_class", "match", AD_CLASS_RE)
        .gte("emitted_at", since)
        .lte("emitted_at", until);
      if (after) q = q.or(afterCursor("emitted_at", after));
      return q.order("emitted_at", { ascending: true }).order("id", { ascending: true }).limit(RECONCILE_PAGE) as unknown as PromiseLike<PageResult<DecRow>>;
    }, (r) => r.emitted_at),
    walkKeyset<ChRow>((after) => {
      let q = svc
        .from("channel_actions")
        .select("id, tenant_id, run_id, proposed_at")
        .eq("status", "pending")
        .is("exec_status", null)
        .filter("exec_class", "match", AD_CLASS_RE)
        .gte("proposed_at", since)
        .lte("proposed_at", until);
      if (after) q = q.or(afterCursor("proposed_at", after));
      return q.order("proposed_at", { ascending: true }).order("id", { ascending: true }).limit(RECONCILE_PAGE) as unknown as PromiseLike<PageResult<ChRow>>;
    }, (r) => r.proposed_at),
  ]);
  if (dec === null || ch === null) return { scanned: 0, missing: 0, resent: 0, advice_resent: 0, skipped: "scan_failed" };
  const rows: ReconcileRow[] = [
    ...dec.map((r) => ({
      id: r.id,
      tenant_id: r.tenant_id,
      run_id: r.agent_run_id,
      table: "decisions" as const,
      founder: r.founder_chat_order === "true",
      advice_missing: r.founder_advice == null,
    })),
    ...ch.map((r) => ({ id: r.id, tenant_id: r.tenant_id, run_id: r.run_id, table: "channel_actions" as const, founder: false, advice_missing: false })),
  ];
  if (rows.length === 0) return { scanned: 0, missing: 0, resent: 0, advice_resent: 0 };
  const runIds = [...new Set(rows.map((r) => r.run_id).filter((x): x is string => !!x))];
  const runs = new Map<string, ReconcileRun>();
  for (let i = 0; i < runIds.length; i += 200) {
    const { data, error } = await svc
      .from("agent_runs")
      .select("id, trigger, thread_id:payload->>thread_id, operator_thread_id:payload->>operator_thread_id")
      .in("id", runIds.slice(i, i + 200));
    if (error) {
      console.warn(`[approval-strand-probe] chat-card reconcile run read failed: ${error.message}`);
      return { scanned: rows.length, missing: 0, resent: 0, advice_resent: 0, skipped: "scan_failed" };
    }
    for (const r of (data ?? []) as Array<{ id: string; trigger: string | null; thread_id: string | null; operator_thread_id: string | null }>) {
      if (r.trigger) runs.set(r.id, { trigger: r.trigger, thread_id: (r.trigger === "handoff" ? r.operator_thread_id : r.thread_id) ?? null });
    }
  }
  const cards = await loadChatCardEvents(rows.map((r) => r.id));
  if (cards === null) return { scanned: rows.length, missing: 0, resent: 0, advice_resent: 0, skipped: "card_lookup_failed" };
  const plan = planChatCardReconcile(rows, runs, cards);

  const perTenant = new Map<string, number>();
  for (const r of plan.deliver) perTenant.set(r.tenant_id, (perTenant.get(r.tenant_id) ?? 0) + 1);
  for (const [tenant_id, count] of perTenant) {
    await logEvent({ level: "warn", source: "approval_strand", code: "approval.chat_card_missing", tenant_id, message: "chat-origin ad cards with no chat card (re-sent to delivery)", meta: { count } });
  }

  const deliverEvents = plan.deliver.map((r) => ({ id: chatCardEventId(r.table, r.id, r.run_id as string), name: "chat_card/deliver.requested", data: { card_id: r.id, run_id: r.run_id as string, table: r.table } }));
  const adviceEvents = plan.advice.map((r) => ({ id: founderAdviceEventId(r.id), name: "founder_order/advise.requested", data: { decision_id: r.id } }));
  const doSend: SendFn = send ?? ((e) => inngest.send(e as Parameters<typeof inngest.send>[0]));
  const sendAll = async (events: Array<{ id: string; name: string; data: Record<string, unknown> }>): Promise<number> => {
    let sent = 0;
    for (let i = 0; i < events.length; i += 100) {
      const chunk = events.slice(i, i + 100);
      try {
        await doSend(chunk);
        sent += chunk.length;
      } catch (e) {
        console.warn(`[approval-strand-probe] chat-card reconcile send failed (retried next hour): ${(e as Error).message}`);
      }
    }
    return sent;
  };
  const resent = await sendAll(deliverEvents);
  const advice_resent = await sendAll(adviceEvents);
  return { scanned: rows.length, missing: plan.deliver.length, resent, advice_resent };
}

export const approvalStrandProbeFn = inngest.createFunction(
  { id: "approval-strand-probe", name: "Approval strand probe — hourly watch", concurrency: { limit: 1 } },
  { cron: "7 * * * *" },
  async ({ logger, step }) => {
    const r = await probeStrandedApprovals();
    logger.info(
      `approval-strand-probe: ${r.stranded} stranded approval(s) across ${r.tenants} tenant(s) ` +
        `(${r.realStranded} on ${r.realTenants} customer tenant(s); ${r.newLast24h} new in 24h, ` +
        `${r.newlyAged7d} newly past 7d)`,
    );
    const c = await step.run("reconcile-chat-cards", () => reconcileChatCards());
    logger.info(`approval-strand-probe: chat cards ${c.missing} missing of ${c.scanned}, ${c.resent} re-sent, ${c.advice_resent} warnings re-asked${c.skipped ? ` (${c.skipped})` : ""}`);
    const reviews = await step.run("missed-cgo-reviews", async () => {
      const { probeMissedReviews } = await import("@/services/growth/cgo-review-watch");
      return probeMissedReviews();
    });
    logger.info(`approval-strand-probe: ${reviews.missed} Autopilot workspace(s) missed a cgo review${reviews.failed ? ` (watch failed: ${reviews.failed})` : reviews.skipped ? ` (${reviews.skipped})` : ""}`);
    return { ...r, chat_cards: c, missed_cgo_reviews: reviews };
  },
);
