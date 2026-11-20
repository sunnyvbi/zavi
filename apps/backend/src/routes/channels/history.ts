
import type { Request, Response } from "express";
import { isChannelSlug } from "@zavi/shared";
import { requireAuth } from "@/services/auth/middleware";
import { noteShownForClosedAction, type HistoryEvent } from "@/services/channels/channel-actions";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { AD_CHANGE_HEADLINE_FIELDS as CARD_HEADLINE_FIELDS, adCardTitle } from "@zavi/shared";
import { cardOutcome, cardSendState, stageCounts, type CardOutcome, type ResultCounts, type SendFacts, type ViewState } from "@/services/email-cards/cards";
import { stopNoteOf } from "@/services/email-results/view";
import { approverKind, type CardApproval } from "@/services/channels/card-timeline";

const CLOSED_STATUSES: string[] = ["acted", "rejected", "redone", "stale", "displaced"];

const PRE_SWITCH_CLASS = "channel.recipe_step";
const PRE_SWITCH_STATUS = "archived";

const MAX_RUNS = 10;
const MAX_CLOSED = 50;
const MAX_PRE_SWITCH = 50;

const PRE_SWITCH_SCAN = 1000;

const EMAIL_SLUG = "email_marketing";
const EMAIL_SEND_CLASSES = ["bulk_outbound.send", "email_campaign.create_and_send"];
const EMAIL_SEND_DONE_STATUSES = ["acted", "rejected"];
const EMAIL_SEND_COLUMNS = "id, agent_run_id, decision_class, status, emitted_at, dispatched_at, rejected_at, dispatch_error, body";
const EMAIL_BULK_COLUMNS = "decision_id, status, hold_reason, total, sent, failed, unknown, hard_bounces, finished_at";

type EmailSendRow = { id: string; agent_run_id: string | null; decision_class?: string | null; status: string; emitted_at: string | null; dispatched_at: string | null; rejected_at: string | null; dispatch_error: string | null; body: unknown };
type EmailBulkRow = NonNullable<NonNullable<SendFacts>["bulk"]> & { decision_id: string };
type ClosedOut = Record<string, unknown> & { status_at?: unknown; proposed_at?: unknown };

function emailSendSubject(body: unknown): string | null {
  const b = (body && typeof body === "object" ? body : {}) as { subject?: unknown; template?: { subject?: unknown }; variants?: unknown; chosen_variant?: unknown };
  if (typeof b.subject === "string" && b.subject) return b.subject;
  if (typeof b.template?.subject === "string" && b.template.subject) return b.template.subject;
  if (Array.isArray(b.variants)) {
    const n = typeof b.chosen_variant === "number" ? b.chosen_variant : 1;
    const v = (b.variants[n - 1] ?? b.variants[0]) as { content?: { subject?: unknown } } | undefined;
    if (typeof v?.content?.subject === "string" && v.content.subject) return v.content.subject;
  }
  return null;
}

function toClosedEmailSend(r: EmailSendRow, sent: ActionSent | null = null, outcome: CardOutcome | null = null) {
  return {
    id: r.id,
    run_id: r.agent_run_id,
    position: null,
    run_of: null,
    action_type: "send_message",
    title: emailSendSubject(r.body) ?? "Email",
    status: r.status,
    status_at: r.status === "acted" ? r.dispatched_at : r.rejected_at,
    note: null,
    proposed_at: r.emitted_at,
    impact: null,
    impact_reason: null,
    score: null,
    ...(sent ? { sent } : {}),
    outcome: outcome ?? decisionOutcome(r, undefined).outcome,
  };
}

function bodyText(body: unknown, key: string): string | null {
  const v = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" && v ? v : null;
}

type ShownSend = { sent: ActionSent | null; outcome: CardOutcome } | null;

function decisionOutcome(r: EmailSendRow, bulk: EmailBulkRow | undefined) {
  const facts: SendFacts = { card: { status: r.status, approved: r.status !== "rejected", dispatched_at: r.dispatched_at, error: r.dispatch_error }, bulk: bulk ?? null, results: null };
  const s = cardSendState("decisions", { status: r.status, class: r.decision_class ?? undefined, body: (r.body ?? {}) as Record<string, unknown> } as ViewState, facts);
  return { s, outcome: cardOutcome(s, facts) };
}

function emailSendFinishedAsSent(r: EmailSendRow, bulk: EmailBulkRow | undefined): ShownSend {
  const { s, outcome } = decisionOutcome(r, bulk);
  const shown = s.status === "sent" || s.status === "partially_sent" || ((s.status === "outcome_unknown" || s.status === "stopped") && (bulk?.sent ?? 0) > 0);
  if (!shown) return null;
  const zaviList = !!bulk || r.decision_class === "bulk_outbound.send";
  if (zaviList && !bulk) return { sent: null, outcome };
  const stopped = bulk?.status === "held" ? { total: bulk.total, stopped: true as const, note: outcome.may_have_sent ? outcome.reason : stopNoteOf(bulk, bulk.sent, bulk.total) } : {};
  return {
    outcome,
    sent: {
      count: s.sent_count,
      list: bodyText(r.body, zaviList ? "list_name" : "audience_name"),
      tool: zaviList ? "zavi_list" : bodyText(r.body, "tool"),
      at: s.sent_at,
      ...stopped,
    },
  };
}

function emailSendShownAsSent(r: EmailSendRow, bulk: EmailBulkRow | undefined): ShownSend {
  try {
    return emailSendFinishedAsSent(r, bulk);
  } catch (e) {
    console.warn(`[channel-history] ${EMAIL_SLUG} send ${r.id} left out: ${(e as Error).message}`);
    return null;
  }
}

const EMAIL_SEND_PAGE = 100;
const EMAIL_SEND_SCAN = 1000;

type Sb = ReturnType<typeof tenantClient>;

const TOOL_SEND_CLASS = "email_campaign.create_and_send";
const TOOL_RESULT_COLUMNS = "card_id, route, sent_count, finished_at, h1, d7, d7_published_at, note";

type ResultStageRow = { card_id: string; route: string | null; sent_count: unknown; finished_at: string | null; h1: Record<string, unknown> | null; d7: Record<string, unknown> | null; d7_published_at: string | null; note?: string | null };

function latestResults(rows: ResultStageRow[]): Map<string, ResultStageRow> {
  const latest = new Map<string, ResultStageRow>();
  for (const row of rows) {
    const seen = latest.get(row.card_id);
    if (!seen || (row.finished_at ?? "") > (seen.finished_at ?? "")) latest.set(row.card_id, row);
  }
  return latest;
}

function withStageResults(sent: ActionSent, row: ResultStageRow): void {
  if (sent.tool === "zavi_list" || row.route === "zavi_list") return;
  const route = row.route === "sendgrid" || row.route === "mailchimp" || row.route === "klaviyo" ? row.route : null;
  const h1 = stageCounts(row.h1, null, route);
  const d7 = row.d7_published_at !== null ? stageCounts(row.d7, null, route, row.note ?? null) : undefined;
  if (h1) sent.hour_1 = h1;
  if (d7) sent.day_7 = d7;
}

async function withActionResults(sb: Sb, sentByAction: Map<string, ActionSent>): Promise<void> {
  const ids = [...sentByAction].filter(([, sent]) => sent.tool !== "zavi_list").map(([id]) => id);
  if (ids.length === 0) return;
  try {
    const { data, error } = await sb.from("email_send_results").select(TOOL_RESULT_COLUMNS).eq("rail", "channel_actions").in("card_id", ids);
    if (error) {
      console.warn(`[channel-history] ${EMAIL_SLUG} action results: ${error.message}`);
      return;
    }
    for (const [id, row] of latestResults((data ?? []) as ResultStageRow[])) {
      const sent = sentByAction.get(id);
      if (sent) withStageResults(sent, row);
    }
  } catch (e) {
    console.warn(`[channel-history] ${EMAIL_SLUG} action results: ${(e as Error).message}`);
  }
}

async function withToolSendCounts(sb: Sb, toolSends: Map<string, ActionSent>, toolOutcomes: Map<string, CardOutcome>): Promise<void> {
  const ids = [...toolSends.keys()];
  if (ids.length === 0) return;
  try {
    const { data, error } = await sb.from("email_send_results").select(TOOL_RESULT_COLUMNS).eq("rail", "decisions").in("card_id", ids);
    if (error) {
      console.warn(`[channel-history] ${EMAIL_SLUG} send results: ${error.message}`);
      return;
    }
    const latest = latestResults((data ?? []) as ResultStageRow[]);
    for (const [id, row] of latest) {
      const sent = toolSends.get(id);
      if (sent) withStageResults(sent, row);
      if (sent && typeof row.sent_count === "number" && row.sent_count > 0) {
        sent.count = row.sent_count;
        const outcome = toolOutcomes.get(id);
        if (outcome) outcome.sent = row.sent_count;
      }
    }
  } catch (e) {
    console.warn(`[channel-history] ${EMAIL_SLUG} send results: ${(e as Error).message}`);
  }
}

async function readClosedEmailSends(sb: Sb): Promise<{ rows: ClosedOut[] } | { error: string }> {
  const out: ClosedOut[] = [];
  const toolSends = new Map<string, ActionSent>();
  const toolOutcomes = new Map<string, CardOutcome>();
  for (let from = 0; from < EMAIL_SEND_SCAN && out.length < MAX_CLOSED; from += EMAIL_SEND_PAGE) {
    const page = await sb
      .from("decisions")
      .select(EMAIL_SEND_COLUMNS)
      .in("decision_class", EMAIL_SEND_CLASSES)
      .in("status", EMAIL_SEND_DONE_STATUSES)
      .order("emitted_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + EMAIL_SEND_PAGE - 1);
    if (page.error) return { error: page.error.message };
    const fetched = (page.data ?? []) as EmailSendRow[];
    const rows = fetched.filter((r) => r.status === "acted" || !r.dispatch_error);
    const actedIds = rows.filter((r) => r.status === "acted").map((r) => r.id);
    const bulkByDecision = new Map<string, EmailBulkRow>();
    if (actedIds.length > 0) {
      const bulk = await sb.from("email_bulk_sends").select(EMAIL_BULK_COLUMNS).in("decision_id", actedIds);
      if (bulk.error) return { error: bulk.error.message };
      for (const b of (bulk.data ?? []) as EmailBulkRow[]) bulkByDecision.set(b.decision_id, b);
    }
    for (const r of rows) {
      if (r.status !== "acted") {
        out.push(toClosedEmailSend(r));
        continue;
      }
      const shown = emailSendShownAsSent(r, bulkByDecision.get(r.id));
      if (!shown) continue;
      if (shown.sent && r.decision_class === TOOL_SEND_CLASS && out.length < MAX_CLOSED) {
        toolSends.set(r.id, shown.sent);
        toolOutcomes.set(r.id, shown.outcome);
      }
      out.push(toClosedEmailSend(r, shown.sent, shown.outcome));
    }
    if (fetched.length < EMAIL_SEND_PAGE) break;
  }
  await withToolSendCounts(sb, toolSends, toolOutcomes);
  return { rows: out.slice(0, MAX_CLOSED) };
}

const EMAIL_ACTION_SENT_COLUMNS =
  "id, exec_class, exec_status, executed_at, receipt_line:exec_result->receipt->>line, code:exec_result->>code, bucket:exec_result->>bucket, not_sent:exec_result->>not_sent, error:exec_result->>error, tool:exec_payload->>tool, audience_name:exec_payload->>audience_name, list_name:exec_payload->>list_name";

type EmailActionSentRow = {
  id: string;
  exec_class: string | null;
  exec_status: string | null;
  executed_at: string | null;
  receipt_line: string | null;
  code?: string | null;
  bucket?: string | null;
  not_sent?: string | boolean | null;
  error?: string | null;
  tool: string | null;
  audience_name: string | null;
  list_name: string | null;
};
type ActionSent = { count: number | null; list: string | null; tool: string | null; at: string | null; total?: number; stopped?: true; note?: string | null; hour_1?: ResultCounts; day_7?: ResultCounts };

function actionSent(r: EmailActionSentRow): { sent: ActionSent | null; outcome: CardOutcome } {
  const facts: SendFacts = {
    card: {
      status: "acted",
      exec_status: r.exec_status,
      approved: true,
      executed_at: r.executed_at,
      code: r.code ?? null,
      bucket: r.bucket ?? null,
      not_sent: r.not_sent === true || r.not_sent === "true",
      error: typeof r.error === "string" ? r.error.slice(0, 500) : null,
      receipt: r.receipt_line ? { line: r.receipt_line } : null,
    },
    bulk: null,
    results: null,
  };
  const s = cardSendState("channel_actions", { status: "acted", body: r.tool ? { tool: r.tool } : {} } as ViewState, facts);
  const outcome = cardOutcome(s, facts);
  if (s.status !== "sent") return { sent: null, outcome };
  const bulk = r.exec_class === "bulk_outbound.send";
  return { sent: { count: s.sent_count, list: (bulk ? r.list_name : r.audience_name) ?? null, tool: bulk ? "zavi_list" : r.tool ?? null, at: s.sent_at }, outcome };
}

function withEmailSends(actions: ClosedOut[], sends: ClosedOut[]): ClosedOut[] {
  return sends.length > 0 ? [...actions, ...sends].sort(closedOrder).slice(0, MAX_CLOSED) : actions;
}

function closedOrder(a: ClosedOut, b: ClosedOut): number {
  const sa = typeof a.status_at === "string" ? a.status_at : null;
  const sb = typeof b.status_at === "string" ? b.status_at : null;
  if (sa !== sb) {
    if (sa === null) return 1;
    if (sb === null) return -1;
    return sa < sb ? 1 : -1;
  }
  const pa = typeof a.proposed_at === "string" ? a.proposed_at : "";
  const pb = typeof b.proposed_at === "string" ? b.proposed_at : "";
  return pa === pb ? 0 : pa < pb ? 1 : -1;
}
const RUN_ID_CHUNK = 100;

const RUN_COLUMNS = "run_id, executor, trigger, status, enqueued_at, started_at, finished_at, redo_of_action_id";

const CLOSED_COLUMNS =
  "id, run_id, position, run_of, action_type, title, status, status_at, note, proposed_at, impact, impact_reason, score, exec_class, exec_status, executed_at, approved_by, approved_by_source, " +
  CARD_HEADLINE_FIELDS.map((f) => `hl_${f}:exec_payload->${f}`).join(", ");

const PRE_SWITCH_COLUMNS = "agent_run_id, status, emitted_at, archived_at, body";

type DecisionRow = { agent_run_id: string | null; status: string; emitted_at: string | null; archived_at: string | null; body: unknown };

function toPreSwitch(r: DecisionRow) {
  const b = (r.body ?? {}) as { step?: { title?: unknown }; position?: unknown; of?: unknown };
  const title = typeof b.step?.title === "string" ? b.step.title : null;
  return {
    run_id: r.agent_run_id,
    title,
    position: typeof b.position === "number" ? b.position : null,
    of: typeof b.of === "number" ? b.of : null,
    status: r.status,
    emitted_at: r.emitted_at,
    archived_at: r.archived_at,
    source: "decision" as const,
  };
}

export async function channelHistoryGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const slug = String(req.params.slug ?? "");
  if (!isChannelSlug(slug)) {
    res.status(404).json({ error: { code: "unknown_channel", message: "Unknown channel." } });
    return;
  }

  try {
    const sb = tenantClient(asTenantId(auth.tenant_id));

    const [runs, closed, archived, emailSends] = await Promise.all([
      sb
        .from("channel_runs")
        .select(RUN_COLUMNS)
        .eq("channel_slug", slug)
        .order("enqueued_at", { ascending: false })
        .limit(MAX_RUNS),
      sb
        .from("channel_actions")
        .select(CLOSED_COLUMNS)
        .eq("channel_slug", slug)
        .in("status", CLOSED_STATUSES)
        .order("status_at", { ascending: false, nullsFirst: false })
        .order("proposed_at", { ascending: false })
        .limit(MAX_CLOSED),
      sb
        .from("decisions")
        .select(PRE_SWITCH_COLUMNS)
        .eq("status", PRE_SWITCH_STATUS)
        .eq("decision_class", PRE_SWITCH_CLASS)
        .order("archived_at", { ascending: false, nullsFirst: false })
        .limit(PRE_SWITCH_SCAN),
      slug === EMAIL_SLUG ? readClosedEmailSends(sb) : Promise.resolve({ rows: [] as ClosedOut[] }),
    ]);

    const emailError = "error" in emailSends ? emailSends.error : null;
    if (runs.error || closed.error || archived.error || emailError) {
      console.warn(
        `[channel-history] ${slug}: ${runs.error?.message ?? closed.error?.message ?? archived.error?.message ?? emailError}`,
      );
      res.status(500).json({ error: { code: "read_failed", message: "Could not read history." } });
      return;
    }

    const archivedRows = (archived.data ?? []) as DecisionRow[];
    const preSwitchTruncated = archivedRows.length >= PRE_SWITCH_SCAN;

    const candidateIds = [...new Set(archivedRows.map((r) => r.agent_run_id).filter((x): x is string => !!x))];
    const slugRunIds = new Set<string>();
    for (let i = 0; i < candidateIds.length; i += RUN_ID_CHUNK) {
      const chunk = candidateIds.slice(i, i + RUN_ID_CHUNK);
      const { data, error } = await sb
        .from("channel_runs")
        .select("run_id")
        .eq("channel_slug", slug)
        .in("run_id", chunk);
      if (error) {
        console.warn(`[channel-history] ${slug} pre_switch runs: ${error.message}`);
        res.status(500).json({ error: { code: "read_failed", message: "Could not read history." } });
        return;
      }
      for (const r of (data ?? []) as Array<{ run_id: string }>) slugRunIds.add(r.run_id);
    }

    const preSwitch = archivedRows
      .filter((r) => r.agent_run_id && slugRunIds.has(r.agent_run_id))
      .slice(0, MAX_PRE_SWITCH)
      .map(toPreSwitch);

    const closedRows = (closed.data ?? []) as Array<{ id: string; status: string; note: string | null }>;
    const eventsByAction = new Map<string, HistoryEvent[]>();
    const closedIds = closedRows.map((r) => r.id).filter((id) => typeof id === "string" && id.length > 0);
    if (closedIds.length > 0) {
      const ev = await sb
        .from("channel_action_events")
        .select("action_id, event, note, at, snoozed_until")
        .in("action_id", closedIds)
        .order("at", { ascending: false });
      if (ev.error) {
        console.warn(`[channel-history] ${slug} events: ${ev.error.message}`);
        res.status(500).json({ error: { code: "read_failed", message: "Could not read history." } });
        return;
      }
      for (const row of (ev.data ?? []) as HistoryEvent[]) {
        const list = eventsByAction.get(row.action_id) ?? [];
        list.push(row);
        eventsByAction.set(row.action_id, list);
      }
    }

    const closedEmailSends: ClosedOut[] = "rows" in emailSends ? emailSends.rows : [];

    const postedByAction = new Map<string, { line: string; url?: string }>();
    const actedIds = closedRows.filter((r) => r.status === "acted").map((r) => r.id);
    if (actedIds.length > 0) {
      try {
        const { readPostedCards } = await import("@/services/channels/post-live");
        for (const p of await readPostedCards(auth.tenant_id, slug, { ids: actedIds })) {
          postedByAction.set(p.id, p.url ? { line: p.line, url: p.url } : { line: p.line });
        }
      } catch (e) {
        console.warn(`[channel-history] ${slug} posted cards: ${(e as Error).message}`);
      }
    }

    const sentByAction = new Map<string, ActionSent>();
    const outcomeByAction = new Map<string, CardOutcome>();
    const emailActionIds = slug === EMAIL_SLUG
      ? (closedRows as Array<{ id: string; status: string; exec_class?: string | null }>)
          .filter((r) => r.status === "acted" && EMAIL_SEND_CLASSES.includes(String(r.exec_class)))
          .map((r) => r.id)
      : [];
    if (emailActionIds.length > 0) {
      const sent = await sb.from("channel_actions").select(EMAIL_ACTION_SENT_COLUMNS).in("id", emailActionIds);
      if (sent.error) {
        console.warn(`[channel-history] ${slug} email sends: ${sent.error.message}`);
        res.status(500).json({ error: { code: "read_failed", message: "Could not read history." } });
        return;
      }
      for (const row of (sent.data ?? []) as EmailActionSentRow[]) {
        const out = actionSent(row);
        outcomeByAction.set(row.id, out.outcome);
        if (out.sent) sentByAction.set(row.id, out.sent);
      }
      await withActionResults(sb, sentByAction);
    }

    res.json({
      runs: runs.data ?? [],
      closed: withEmailSends(closedRows.map((r) => {
        const { exec_class, exec_status, executed_at, approved_by, approved_by_source, ...rest } = r as typeof r & {
          exec_class?: string | null;
          exec_status?: string | null;
          executed_at?: string | null;
          approved_by?: string | null;
          approved_by_source?: string | null;
          title?: string;
        };
        const executed = r.status === "acted" && exec_status === "executed";
        const approvedEvent = executed ? (eventsByAction.get(r.id) ?? []).find((e) => e.event === "approved") : undefined;
        const approval: CardApproval | null = approvedEvent
          ? { by: approverKind({ approved_by, approved_by_source }, auth.user_id), name: null, at: approvedEvent.at }
          : null;
        const served: Record<string, unknown> = { ...rest };
        const payload: Record<string, unknown> = {};
        for (const f of CARD_HEADLINE_FIELDS) {
          const v = served[`hl_${f}`];
          delete served[`hl_${f}`];
          if (v !== undefined && v !== null) payload[f] = v;
        }
        return {
          ...served,
          title: adCardTitle({ title: typeof rest.title === "string" ? rest.title : "", exec_class, exec_payload: payload }),
          note: noteShownForClosedAction(r.status, r.note, eventsByAction.get(r.id) ?? []),
          ...(sentByAction.has(r.id) ? { sent: sentByAction.get(r.id) } : {}),
          ...(postedByAction.has(r.id) ? { receipt: postedByAction.get(r.id) } : {}),
          ...(outcomeByAction.has(r.id) ? { outcome: outcomeByAction.get(r.id) } : {}),
          ...(executed ? { executed_at: executed_at ?? null, approval } : {}),
        };
      }), closedEmailSends),
      pre_switch: preSwitch,
      pre_switch_truncated: preSwitchTruncated,
    });
  } catch (e) {
    console.warn(`[channel-history] ${slug}: ${(e as Error).message}`);
    res.status(500).json({ error: { code: "read_failed", message: "Could not read history." } });
  }
}
