
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { enqueueGoalOwnerRun } from "@/services/growth/goal-owner";
import { NOTE_BATCH_PERIOD, NOTE_BATCH_TIMEOUT } from "@/services/growth/cgo-note-batch";
import type { GrowthGoalAttention } from "../client";

type Attention = GrowthGoalAttention["data"];

export async function resolveAttentionTenant(data: Attention): Promise<string | null> {
  const svc = serviceClient();
  const read = async (table: string, id: string) => {
    const { data: row, error } = await svc.from(table).select("tenant_id").eq("id", id).maybeSingle<{ tenant_id: string }>();
    if (error) throw new Error(`cgo-goal-owner: ${table} read failed: ${error.message}`);
    return row?.tenant_id ?? null;
  };
  if (data.goal_id) return read("autopilot_goals", data.goal_id);
  if (data.run_id) return read("agent_runs", data.run_id);
  if (data.decision_id) return read("decisions", data.decision_id);
  return null;
}

export async function handleGoalAttention(data: Attention) {
  const tenant_id = await resolveAttentionTenant(data);
  if (!tenant_id) return { skipped: "row_not_found" as const };
  if (tenant_id !== data.tenant_id) {
    console.warn(`[cgo-goal-owner] C8-reverified: the event's tenant does not own the row it names; skipped`);
    return { skipped: "tenant_mismatch" as const };
  }
  return enqueueGoalOwnerRun({
    tenant_id,
    reason: data.reason,
    goal_id: data.goal_id ?? null,
    run_id: data.run_id ?? null,
    decision_id: data.decision_id ?? null,
  });
}

export const cgoGoalOwnerFn = inngest.createFunction(
  {
    id: "cgo-goal-owner",
    retries: 2,
    debounce: { key: "event.data.tenant_id", period: "10m" },
    concurrency: { key: "event.data.tenant_id", limit: 1 },
  },
  { event: "growth/goal.attention" },
  async ({ event, step }) => step.run("review", () => handleGoalAttention(event.data)),
);

async function noteContext(
  tenant_id: string,
  autopilot: boolean,
): Promise<{ companyName: string; autopilot: boolean; growthUrl: string; adsEvery2h: boolean }> {
  const { data: t } = await serviceClient()
    .from("tenants")
    .select("display_name, slug")
    .eq("id", tenant_id)
    .maybeSingle<{ display_name: string | null; slug: string | null }>();
  const { webBaseUrl } = await import("@/services/web-base");
  return {
    companyName: (t?.display_name ?? "").trim() || (t?.slug ?? "").trim() || "Your company",
    autopilot,
    adsEvery2h: autopilot && (await (await import("@/services/growth/cgo-ads")).cgoAdBudget(tenant_id)) !== null,
    growthUrl: `${webBaseUrl()}/workspace?tab=growth-strategy&company=${encodeURIComponent(tenant_id)}`,
  };
}

export type NoteRef = { run_id: string } | { note_id: string };

type SendableNote = {
  id: string;
  kind: "scheduled" | "alarm" | "founder";
  saw: string[] | null;
  changed: string[] | null;
  would_change: string[] | null;
  need: string[] | null;
  next_review_at: string | null;
  items?: unknown[] | null;
  headline?: string | null;
  created_at: string;
  notified?: boolean | null;
};

const NOTE_COLS = "id, tenant_id, run_id, kind, saw, changed, would_change, need, next_review_at, items, headline, created_at, notified";

async function loadNote(ref: NoteRef): Promise<{ tenant_id: string; autopilot: boolean; note: SendableNote; key: string } | "not_a_cgo_run" | "no_note"> {
  const svc = serviceClient();
  const cols = NOTE_COLS;
  if ("note_id" in ref) {
    const { data, error } = await svc.from("cgo_notes").select(cols).eq("id", ref.note_id).is("run_id", null).maybeSingle<SendableNote & { tenant_id: string }>();
    if (error) throw new Error(`cgo-goal-owner: note read failed: ${error.message}`);
    if (!data) return "no_note";
    return { tenant_id: data.tenant_id, autopilot: true, note: data, key: `note:${data.id}` };
  }
  const { data: run, error: runErr } = await svc
    .from("agent_runs")
    .select("tenant_id, agent_slug, payload")
    .eq("id", ref.run_id)
    .maybeSingle<{ tenant_id: string; agent_slug: string; payload: { autopilot?: unknown } | null }>();
  if (runErr) throw new Error(`cgo-goal-owner: run read failed: ${runErr.message}`);
  if (!run || run.agent_slug !== "cgo") return "not_a_cgo_run";
  const { data: note, error: noteErr } = await svc
    .from("cgo_notes")
    .select(cols)
    .eq("tenant_id", run.tenant_id)
    .eq("run_id", ref.run_id)
    .maybeSingle<SendableNote>();
  if (noteErr) throw new Error(`cgo-goal-owner: note read failed: ${noteErr.message}`);
  if (!note) return "no_note";
  return { tenant_id: run.tenant_id, autopilot: run.payload?.autopilot === true, note, key: ref.run_id };
}

function refOfNote(n: { id: string; run_id: string | null }): NoteRef {
  return n.run_id ? { run_id: n.run_id } : { note_id: n.id };
}

export async function planNoteBatch(ref: NoteRef, now: Date = new Date()): Promise<NoteRef[]> {
  const first = await loadNote(ref);
  if (typeof first === "string") return [];
  const { NOTE_BATCH_LOOKBACK_MS, NOTE_BATCH_MAX } = await import("@/services/growth/cgo-note-batch");
  const { data, error } = await serviceClient()
    .from("cgo_notes")
    .select(NOTE_COLS)
    .eq("tenant_id", first.tenant_id)
    .not("queued_at", "is", null)
    .or("notified.is.null,notified.eq.false")
    .gte("created_at", new Date(now.getTime() - NOTE_BATCH_LOOKBACK_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(NOTE_BATCH_MAX);
  if (error) throw new Error(`cgo-goal-owner: pending notes read failed: ${error.message}`);
  const rows = ((data ?? []) as Array<SendableNote & { run_id: string | null }>).slice();
  const own = first.note;
  if (own.notified !== true && !rows.some((r) => r.id === own.id)) rows.push({ ...own, run_id: "run_id" in ref ? ref.run_id : null });
  const { isNoteVisible } = await import("@/services/growth/goal-owner");
  return rows.filter((r) => isNoteVisible(r)).map(refOfNote);
}

type LoadedBatch = { tenant_id: string; autopilot: boolean; note: SendableNote; key: string; runIds: string[]; since: string };

async function loadNotes(refs: readonly NoteRef[]): Promise<LoadedBatch | "not_a_cgo_run" | "no_note"> {
  const loaded: Array<{ tenant_id: string; autopilot: boolean; note: SendableNote; key: string; run_id: string | null; created_at: string }> = [];
  let reason: "not_a_cgo_run" | "no_note" = "no_note";
  for (const ref of refs) {
    const one = await loadNote(ref);
    if (typeof one === "string") {
      reason = one;
      continue;
    }
    if (loaded.length && one.tenant_id !== loaded[0].tenant_id) {
      console.warn(`[cgo-goal-owner] a batched note belongs to another tenant; dropped`);
      continue;
    }
    loaded.push({ ...one, run_id: "run_id" in ref ? ref.run_id : null, created_at: one.note.created_at });
  }
  if (loaded.length === 0) return reason;
  const { mergeNotes, primaryNote } = await import("@/services/growth/cgo-note-batch");
  const primary = primaryNote(loaded);
  const merged = mergeNotes(loaded.map((l) => ({ ...l.note, run_id: l.run_id })));
  return {
    tenant_id: primary.tenant_id,
    autopilot: primary.autopilot,
    note: merged,
    key: primary.key,
    runIds: [...new Set(loaded.map((l) => l.run_id).filter((x): x is string => !!x))],
    since: new Date(Math.min(...loaded.map((l) => Date.parse(l.created_at))) - 2 * 60_000).toISOString(),
  };
}

async function loadBatchQuestions(tenant_id: string, runIds: readonly string[], needLines: readonly string[] = [], since?: string): Promise<OpenQuestionView[]> {
  const all = (await Promise.all([...runIds.map((r) => loadOpenQuestions(tenant_id, r)), needLines.length ? loadOpenQuestions(tenant_id, null, needLines, since) : []])).flat();
  const seen = new Set<string>();
  return all
    .filter((q) => (seen.has(q.id) ? false : (seen.add(q.id), true)))
    .sort((a, b) => (a.ordinal ?? Number.MAX_SAFE_INTEGER) - (b.ordinal ?? Number.MAX_SAFE_INTEGER));
}

function asRefs(ref: NoteRef | readonly NoteRef[]): NoteRef[] {
  return Array.isArray(ref) ? [...ref] : [ref as NoteRef];
}

export type OpenQuestionView = {
  id: string;
  ordinal: number | null;
  ask: string;
  recommended: "yes" | "no" | null;
  why: string | null;
  yesNo: boolean;
  noteLine: string;
  asked_at: string;
  factCheck?: boolean;
};

export async function loadOpenQuestions(tenant_id: string, run_id: string | null, runlessAsks?: readonly string[], since?: string): Promise<OpenQuestionView[]> {
  let data: unknown[] | null = null;
  try {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    let q = tenantClient(asTenantId(tenant_id))
      .from("cgo_questions")
      .select("id, ordinal, ask, recommended, why, default_line, asked_at, topic_key")
      .eq("tenant_id", tenant_id)
      .eq("status", "open");
    if (run_id) q = q.eq("asked_run_id", run_id);
    else if (runlessAsks) {
      q = q.is("asked_run_id", null).in("ask", [...runlessAsks]);
      if (since) q = q.gte("asked_at", since);
    }
    const r = await q.order("ordinal", { ascending: true }).limit(20);
    if (r.error) throw new Error(r.error.message);
    data = r.data;
  } catch (e) {
    console.warn(`[cgo-goal-owner] open questions read failed: ${(e as Error).message}`);
    return [];
  }
  const { isYesNoAsk, HYPOTHESIS_TOPIC } = await import("@/services/growth/cgo-questions");
  const { questionNoteLine } = await import("@/services/growth/goal-owner");
  return ((data ?? []) as Array<{ id: string; ordinal: number | null; ask: string; recommended: "yes" | "no" | null; why: string | null; default_line: string | null; asked_at: string; topic_key?: string | null }>).map((r) => ({
    id: r.id,
    ordinal: r.ordinal,
    ask: r.ask,
    recommended: r.recommended,
    why: r.why,
    yesNo: isYesNoAsk(r.ask),
    noteLine: questionNoteLine(r.ask, r.default_line),
    asked_at: r.asked_at,
    ...(r.topic_key?.startsWith(HYPOTHESIS_TOPIC) ? { factCheck: true } : {}),
  }));
}

function emailQuestions(qs: OpenQuestionView[], reply: { to: string; subject: string; ref: string } | null, mailto: (a: { to: string; subject: string; ref: string; body: string }) => string) {
  return qs.map((q) => {
    const tap = reply && q.yesNo && q.ordinal != null;
    return {
      ordinal: q.ordinal,
      ask: q.ask,
      recommended: q.recommended,
      why: q.why,
      yesHref: tap ? mailto({ ...reply!, body: `${q.ordinal} yes` }) : null,
      noHref: tap ? mailto({ ...reply!, body: `${q.ordinal} no` }) : null,
      ...(q.factCheck ? { factCheck: true } : {}),
    };
  });
}

async function worthSending(note: SendableNote): Promise<boolean> {
  const { parseNoteItems } = await import("@/services/growth/cgo-note-items");
  const { noteWorthSending } = await import("@/services/growth/cgo-note-story");
  return noteWorthSending({ ...note, items: parseNoteItems(note.items) });
}

export function bindNeedOrdinals<T extends { section: string; text: string; question_ordinal?: number | null }>(items: T[] | null, questions: readonly OpenQuestionView[]): T[] | null {
  if (!items) return items;
  return items.map((i) => {
    if (i.section !== "needs_you" || i.question_ordinal != null) return i;
    const matches = questions.filter((x) => x.ask === i.text && x.ordinal != null);
    return matches.length === 1 ? { ...i, question_ordinal: matches[0].ordinal } : i;
  });
}

function runlessNeed(loaded: LoadedBatch): string[] {
  return (loaded.note.need ?? []).filter((l) => typeof l === "string" && l.trim()).slice(0, 5);
}

export async function sendNoteEmailForRun(run_id: string) {
  return sendNoteEmail({ run_id });
}

export async function sendNoteEmail(ref: NoteRef | readonly NoteRef[]) {
  if (!process.env.SYSTEM_SENDGRID_API_KEY) return { sent: false, reason: "no_system_key" as const };
  const loaded = await loadNotes(asRefs(ref));
  if (typeof loaded === "string") return { sent: false, reason: loaded };
  const { tenant_id, note } = loaded;
  const { isNoteVisible } = await import("@/services/growth/goal-owner");
  if (!isNoteVisible(note)) return { sent: false, reason: "not_visible" as const };
  if (!(await worthSending(note))) return { sent: false, reason: "nothing_to_tell" as const };

  const { resolveTenantOwnerEmail } = await import("@/email/sendAuthEmail");
  const email = await resolveTenantOwnerEmail(tenant_id);
  if (!email) return { sent: false, reason: "no_owner_email" as const };
  const { renderCgoNoteEmail } = await import("@/email/templates/cgo-note");
  const { loadActiveGoals, noteGoalViews, isGoalSawLine, goalTimeZone, dayInZone } = await import("@/services/growth/goal-owner");
  const tz = await goalTimeZone(tenant_id);
  const goals = await loadActiveGoals(tenant_id).catch(() => []);
  const saw = note.saw ?? [];
  const questions = await loadBatchQuestions(tenant_id, loaded.runIds, runlessNeed(loaded), loaded.since);
  const shown = new Set(questions.map((q) => q.noteLine));
  const { resolveInboxIdentity, mintMessageId } = await import("@/email/sendAgentOwnedEmail");
  const { oneTapRef, oneTapMailto } = await import("@/email/one-tap");
  const inbox = process.env.AGENTMAIL_FROM_IDENTITY !== "0" ? await resolveInboxIdentity(tenant_id) : null;
  const identity = questions.length ? inbox : null;
  const messageId = identity ? mintMessageId(identity.address) : undefined;
  const ref0 = messageId ? oneTapRef(messageId) : null;
  const { parseNoteItems } = await import("@/services/growth/cgo-note-items");
  const items = bindNeedOrdinals(parseNoteItems(note.items), questions);
  const hasItems = !!items && items.length > 0;
  const base = {
    ...(await noteContext(tenant_id, loaded.autopilot)),
    goals: noteGoalViews(goals, dayInZone(new Date(), tz), await (await import("@/services/growth/founder-estimate")).readFounderCustomersAnswer(tenant_id), tz),
    goalSawLines: saw.filter((l) => isGoalSawLine(l, goals, note.changed ?? [])),
    saw,
    changed: note.changed ?? [],
    wouldChange: note.would_change ?? [],
    need: hasItems ? [] : (note.need ?? []).filter((l) => !shown.has(l)),
    nextReviewAt: note.next_review_at,
    items,
    headline: note.headline ?? null,
    tenantId: tenant_id,
    kind: note.kind,
    canReply: inbox !== null,
  };
  const subject = renderCgoNoteEmail({ ...base, questions: emailQuestions(questions, null, oneTapMailto) }).subject;
  const reply = identity && ref0 ? { to: identity.address, subject, ref: ref0 } : null;
  const r = renderCgoNoteEmail({ ...base, questions: emailQuestions(questions, reply, oneTapMailto) });
  const { sendAgentOwnedEmail } = await import("@/email/sendAgentOwnedEmail");
  const { systemSender } = await import("@/email/system-identity");
  await sendAgentOwnedEmail({
    tenant_id,
    agent_slug: "cgo",
    to: email,
    subject: r.subject,
    html: r.html,
    text: r.text,
    fallbackFrom: systemSender(),
    ...(messageId ? { messageId } : {}),
    noteKey: loaded.key,
  });
  return { sent: true as const };
}

export async function sendQuestionReminder(tenant_id: string, questions: OpenQuestionView[]) {
  if (!process.env.SYSTEM_SENDGRID_API_KEY) return { sent: false, reason: "no_system_key" as const };
  if (questions.length === 0) return { sent: false, reason: "nothing_open" as const };
  const { resolveTenantOwnerEmail } = await import("@/email/sendAuthEmail");
  const email = await resolveTenantOwnerEmail(tenant_id);
  if (!email) return { sent: false, reason: "no_owner_email" as const };
  const { renderCgoNoteEmail } = await import("@/email/templates/cgo-note");
  const { resolveInboxIdentity, mintMessageId, sendAgentOwnedEmail } = await import("@/email/sendAgentOwnedEmail");
  const { oneTapRef, oneTapMailto } = await import("@/email/one-tap");
  const { systemSender } = await import("@/email/system-identity");
  const identity = process.env.AGENTMAIL_FROM_IDENTITY !== "0" ? await resolveInboxIdentity(tenant_id) : null;
  const messageId = identity ? mintMessageId(identity.address) : undefined;
  const ref0 = messageId ? oneTapRef(messageId) : null;
  const first = questions[0].ask;
  const subject = `Waiting on you: ${first.length > 90 ? `${first.slice(0, 89)}…` : first}`;
  const reply = identity && ref0 ? { to: identity.address, subject, ref: ref0 } : null;
  const ctx = await noteContext(tenant_id, true);
  const r = renderCgoNoteEmail({ ...ctx, saw: [], changed: [], need: [], canReply: identity !== null, questions: emailQuestions(questions, reply, oneTapMailto) });
  await sendAgentOwnedEmail({
    tenant_id,
    agent_slug: "cgo",
    to: email,
    subject,
    html: r.html,
    text: r.text,
    fallbackFrom: systemSender(),
    ...(messageId ? { messageId } : {}),
  });
  return { sent: true as const };
}

const PERMANENT_DM_ERRORS = new Set([
  "users_not_found",
  "user_not_found",
  "account_inactive",
  "user_disabled",
  "cannot_dm_bot",
  "user_not_visible",
  "missing_scope",
  "not_authed",
  "invalid_auth",
  "token_revoked",
  "token_expired",
  "team_access_not_granted",
]);

export async function sendNoteSlackDmForRun(run_id: string) {
  return sendNoteSlackDm({ run_id });
}

export async function sendNoteSlackDm(ref: NoteRef | readonly NoteRef[]) {
  const svc = serviceClient();
  const loaded = await loadNotes(asRefs(ref));
  if (typeof loaded === "string") return { sent: false, reason: loaded };
  const { note } = loaded;
  const run = { tenant_id: loaded.tenant_id };
  const run_id = loaded.key.startsWith("note:") ? null : loaded.key;
  const { isNoteVisible } = await import("@/services/growth/goal-owner");
  if (!isNoteVisible(note)) return { sent: false, reason: "not_visible" as const };
  if (!(await worthSending(note))) return { sent: false, reason: "nothing_to_tell" as const };

  const { resolveTenantOwnerEmail } = await import("@/email/sendAuthEmail");
  const email = await resolveTenantOwnerEmail(run.tenant_id);
  if (!email) return { sent: false, reason: "no_owner_email" as const };

  const { resolveTargetSlackWorkspace } = await import("@/services/slack/resolve-target-workspace");
  const ws = await resolveTargetSlackWorkspace(run.tenant_id, "cgo");
  if (!ws) return { sent: false, reason: "no_slack" as const };

  const { slackFetch } = await import("@/services/tools/slack/_client");
  const { ExpectedToolError } = await import("@/services/tools/types");
  let dmChannel: string | undefined;
  let userId: string | undefined;
  try {
    const who = await slackFetch<{ user?: { id?: string } }>(run.tenant_id, "users.lookupByEmail", { email }, ws.team_id);
    userId = who.user?.id;
    if (!userId) return { sent: false, reason: "no_slack_member" as const };
    const open = await slackFetch<{ channel?: { id?: string } }>(run.tenant_id, "conversations.open", { users: userId }, ws.team_id);
    dmChannel = open.channel?.id;
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "slack_not_connected") return { sent: false, reason: "no_slack" as const };
    const slackError = e instanceof ExpectedToolError ? String(e.meta?.slack_error ?? "") : "";
    if (e instanceof ExpectedToolError && e.code === "slack_api_error" && PERMANENT_DM_ERRORS.has(slackError)) {
      return { sent: false, reason: "no_slack_member" as const };
    }
    throw e;
  }
  if (!dmChannel) return { sent: false, reason: "no_dm_channel" as const };

  const { renderCgoNoteSlackMessage } = await import("@/services/growth/cgo-note-slack");
  const ctx = await noteContext(run.tenant_id, loaded.autopilot);
  const { enqueueSlackOutbox } = await import("@/services/slack/outbox");
  const { encodeOutboxBody } = await import("@/services/slack/outbox-body");
  const { parseNoteItems } = await import("@/services/growth/cgo-note-items");
  const slackQuestions = await loadBatchQuestions(run.tenant_id, loaded.runIds, runlessNeed(loaded), loaded.since);
  const msg = renderCgoNoteSlackMessage({
    items: bindNeedOrdinals(parseNoteItems(note.items), slackQuestions),
    headline: note.headline ?? null,
    tenantId: run.tenant_id,
    kind: note.kind,
    changed: note.changed ?? [],
    wouldChange: note.would_change ?? [],
    need: note.need ?? [],
    nextReviewAt: note.next_review_at,
    companyName: ctx.companyName,
    growthUrl: ctx.growthUrl,
    adsEvery2h: ctx.adsEvery2h,
    questions: slackQuestions,
    goals: await (async () => {
      const g = await import("@/services/growth/goal-owner");
      const est = await (await import("@/services/growth/founder-estimate")).readFounderCustomersAnswer(run.tenant_id);
      const tz = await g.goalTimeZone(run.tenant_id);
      return g.noteGoalViews(await g.loadActiveGoals(run.tenant_id).catch(() => []), g.dayInZone(new Date(), tz), est, tz);
    })(),
  });
  const seq = await enqueueSlackOutbox({
    tenant_id: run.tenant_id,
    channel_id: dmChannel,
    kind: "cgo_note",
    body: encodeOutboxBody(msg.text, msg.blocks),
    run_id,
    team_id: ws.team_id,
    idempotency_key: `cgo_note_dm:${loaded.key}`,
  });
  if (seq == null) throw new Error("cgo-goal-owner: Slack DM enqueue failed");
  const { error: recErr } = await svc
    .from("slack_outbox")
    .update({ recipient_slack_user: userId })
    .eq("tenant_id", run.tenant_id)
    .eq("idempotency_key", `cgo_note_dm:${loaded.key}`);
  if (recErr) console.warn(`[cgo-goal-owner] recording the DM recipient failed: ${recErr.message}`);
  return { sent: true as const };
}

export async function settleNoteDelivery(ref: NoteRef, delivered: boolean): Promise<void> {
  const svc = serviceClient();
  const q = svc.from("cgo_notes").select("id, tenant_id");
  const { data, error } = await ("note_id" in ref ? q.eq("id", ref.note_id).is("run_id", null) : q.eq("run_id", ref.run_id)).limit(1).maybeSingle<{ id: string; tenant_id: string }>();
  if (error) throw new Error(`cgo-goal-owner: note read for delivery failed: ${error.message}`);
  if (!data) return;
  const update = svc.from("cgo_notes").update(delivered ? { notified: true } : { notification_key: null, queued_at: null }).eq("id", data.id).eq("tenant_id", data.tenant_id);
  const { error: upErr } = await (delivered ? update : update.eq("notified", false));
  if (upErr) throw new Error(`cgo-goal-owner: delivery mark failed: ${upErr.message}`);
}

function refOf(data: { note_id?: unknown; run_id?: unknown }): NoteRef {
  return data.note_id ? { note_id: String(data.note_id) } : { run_id: String(data.run_id) };
}

async function settleAll(refs: readonly NoteRef[], delivered: boolean): Promise<void> {
  for (const r of refs) await settleNoteDelivery(r, delivered);
}

export const cgoNoteEmailFn = inngest.createFunction(
  {
    id: "cgo-note-email",
    retries: 3,
    debounce: { key: "event.data.tenant_id", period: NOTE_BATCH_PERIOD, timeout: NOTE_BATCH_TIMEOUT },
    onFailure: async ({ event }) => {
      const original = (event.data as { event?: { data?: { note_id?: unknown; run_id?: unknown } } }).event?.data ?? {};
      await settleNoteDelivery(refOf(original), false);
    },
  },
  { event: "cgo/note.email" },
  async ({ event, step }) => {
    const refs = await step.run("batch", () => planNoteBatch(refOf(event.data)));
    if (refs.length === 0) return { skipped: "already_delivered" as const };
    const email = await step.run("send", () => sendNoteEmail(refs));
    if (email.sent) await step.run("delivered-email", () => settleAll(refs, true));
    const slack = await step.run("slack-dm", () => sendNoteSlackDm(refs));
    if (slack.sent && !email.sent) await step.run("delivered-slack", () => settleAll(refs, true));
    if (!email.sent && !slack.sent) await step.run("undelivered", () => settleAll(refs, false));
    return { email, slack, notes: refs.length };
  },
);
