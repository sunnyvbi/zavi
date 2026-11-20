
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import type { OnYes, QuestionRow } from "./cgo-questions";

export type AnswerVia = "email" | "slack" | "web";
export type Answer = "yes" | "no" | "not_now" | { text: string };

export type AnswerOutcome =
  | {
      question_id: string;
      outcome: "answered";
      ordinal: number | null;
      ask: string;
      answer: string;
      applied: string | null;
      note?: string | null;
      undoable?: boolean;
    }
  | { question_id: string; outcome: "already_answered"; ordinal: number | null; ask: string; answer: string | null; via: string | null; at: string | null }
  | { question_id: string; outcome: "closed"; ordinal: number | null; ask: string }
  | { question_id: string; outcome: "not_found" };

type Deps = {
  applyApprovedGoalChange?: (tenant_id: string, run_id: string, a: OnYes, now: Date) => Promise<string | null>;
  applyHeldOrder?: typeof import("./held-order-yes").applyHeldOrderYes;
  wake?: (tenant_id: string, via: AnswerVia, text: string, key: string) => Promise<void>;
};

const COLS = "id, ordinal, ask, status, answer, answered_via, answered_at, on_yes, asked_run_id";
type Row = Pick<QuestionRow, "id" | "ordinal" | "ask" | "status" | "answer" | "answered_via" | "answered_at" | "on_yes" | "asked_run_id">;

function answerText(a: Answer): string {
  if (typeof a === "string") return a;
  return `My words: ${a.text.trim().replace(/\s+/g, " ")}`.slice(0, 500);
}

export function answerLabel(answer: string | null | undefined): string {
  if (answer === "yes") return "Yes";
  if (answer === "no") return "No";
  if (answer === "not_now") return "Not now";
  const own = answer ? answer.replace(/^My words: /, "") : answer;
  return own ? `"${own.length > 80 ? `${own.slice(0, 79)}…` : own}"` : "answered";
}

async function priorOutcome(tenant_id: string, question_id: string): Promise<AnswerOutcome> {
  const { data: prior, error } = await tenantClient(asTenantId(tenant_id))
    .from("cgo_questions")
    .select(COLS)
    .eq("id", question_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle<Row>();
  if (error) throw new Error(`cgo-answers: reading ${question_id} failed: ${error.message}`);
  if (prior && prior.status !== "answered") return { question_id: prior.id, outcome: "closed", ordinal: prior.ordinal ?? null, ask: prior.ask };
  return prior
    ? {
        question_id: prior.id,
        outcome: "already_answered",
        ordinal: prior.ordinal ?? null,
        ask: prior.ask,
        answer: prior.answer ?? null,
        via: prior.answered_via ?? null,
        at: prior.answered_at ?? null,
      }
    : { question_id, outcome: "not_found" };
}

const STALE_NOTE: Record<string, string> = {
  gone: "Nothing changed: that idea is no longer on your goal.",
  confirmed: "Nothing changed: that idea was already confirmed.",
  ruled_out: "Nothing changed: that idea was already ruled out.",
  reworded: "Nothing changed: I re-worded that idea since asking, so I'll ask about the new wording.",
};

async function answerHypothesisQuestion(
  args: { tenant_id: string; question_id: string; answer: Answer; via: AnswerVia; actor_user_id: string | null },
): Promise<AnswerOutcome | null> {
  const kind = args.answer === "yes" || args.answer === "no" ? args.answer : "words";
  const { data, error } = await tenantRpc(asTenantId(args.tenant_id), "answer_hypothesis_question", {
    p_tenant_id: args.tenant_id,
    p_question_id: args.question_id,
    p_kind: kind,
    p_answer: answerText(args.answer),
    p_words: typeof args.answer === "object" ? args.answer.text : null,
    p_via: args.via,
    p_actor: args.actor_user_id,
  });
  if (error) throw new Error(`cgo-answers: answering hypothesis question ${args.question_id} failed: ${error.message}`);
  const r = (data ?? {}) as { outcome?: string; reason?: string; line?: string | null };
  if (r.outcome === "wrong_kind") return null;
  if (r.outcome !== "applied" && r.outcome !== "stale") return priorOutcome(args.tenant_id, args.question_id);
  const { data: row } = await tenantClient(asTenantId(args.tenant_id))
    .from("cgo_questions")
    .select("ordinal, ask")
    .eq("id", args.question_id)
    .eq("tenant_id", args.tenant_id)
    .maybeSingle<{ ordinal: number | null; ask: string }>();
  return {
    question_id: args.question_id,
    outcome: "answered",
    ordinal: row?.ordinal ?? null,
    ask: row?.ask ?? "",
    answer: answerText(args.answer),
    applied: r.outcome === "applied" ? (r.line ?? null) : null,
    note: r.outcome === "stale" ? (STALE_NOTE[r.reason ?? ""] ?? STALE_NOTE.gone) : null,
  };
}

export async function answerQuestions(
  args: {
    tenant_id: string;
    answers: Array<{ question_id: string; answer: Answer }>;
    via: AnswerVia;
    actor_user_id: string | null;
    now?: Date;
  },
  deps: Deps = {},
): Promise<AnswerOutcome[]> {
  const now = args.now ?? new Date();
  const db = tenantClient(asTenantId(args.tenant_id));
  const out: AnswerOutcome[] = [];
  const seen = new Set<string>();
  const heldYes = async (row: Row, text: string): Promise<AnswerOutcome> => {
    const onYes = row.on_yes as Extract<OnYes, { kind: "held_ad_order" }>;
    const apply = deps.applyHeldOrder ?? (await import("./held-order-yes")).applyHeldOrderYes;
    const r = await apply({ tenant_id: args.tenant_id, question: { id: row.id, on_yes: onYes }, approver_user_id: args.actor_user_id, via: args.via, now });
    if (r.line) {
      const { error: lineErr } = await db.from("cgo_questions").update({ applied_line: r.line.slice(0, 400) }).eq("id", row.id).eq("tenant_id", args.tenant_id);
      if (lineErr) console.warn(`[cgo-answers] recording the applied order failed: ${lineErr.message}`);
      return { question_id: row.id, outcome: "answered", ordinal: row.ordinal ?? null, ask: row.ask, answer: text, applied: r.line, undoable: false };
    }
    let reasked = false;
    if (r.reask) {
      const { data: wRows, error: wErr } = await db.from("cgo_questions").update({ status: "withdrawn" }).eq("id", row.id).eq("tenant_id", args.tenant_id).eq("status", "answered").select("id");
      if (wErr) console.warn(`[cgo-answers] withdrawing the drifted order question failed: ${wErr.message}`);
      reasked = !wErr && ((wRows ?? []) as unknown[]).length === 1;
    }
    const note = `Nothing changed: ${r.refused}.${reasked ? " I'll ask again with the numbers as they are now." : ""}`;
    return { question_id: row.id, outcome: "answered", ordinal: row.ordinal ?? null, ask: row.ask, answer: text, applied: null, note };
  };
  for (const a of args.answers) {
    if (seen.has(a.question_id)) continue;
    seen.add(a.question_id);
    const text = answerText(a.answer);
    if (!text) continue;
    const { data: kindRow, error: kindErr } = await db
      .from("cgo_questions")
      .select("on_yes")
      .eq("id", a.question_id)
      .eq("tenant_id", args.tenant_id)
      .maybeSingle<{ on_yes: OnYes | null }>();
    if (kindErr) throw new Error(`cgo-answers: reading ${a.question_id} failed: ${kindErr.message}`);
    if (kindRow?.on_yes?.kind === "hypothesis_check") {
      if (a.answer === "not_now") continue;
      const r = await answerHypothesisQuestion({ tenant_id: args.tenant_id, question_id: a.question_id, answer: a.answer, via: args.via, actor_user_id: args.actor_user_id });
      if (r) {
        out.push(r);
        continue;
      }
    }
    const { data, error } = await db
      .from("cgo_questions")
      .update({
        status: "answered",
        answer: text,
        answered_at: now.toISOString(),
        answered_via: args.via,
        answered_by: args.actor_user_id,
        founder_replied_at: now.toISOString(),
      })
      .eq("id", a.question_id)
      .eq("tenant_id", args.tenant_id)
      .eq("status", "open")
      .or("on_yes.is.null,on_yes->>kind.neq.hypothesis_check")
      .select(COLS);
    if (error) throw new Error(`cgo-answers: answering ${a.question_id} failed: ${error.message}`);
    const row = ((data ?? []) as Row[])[0];
    if (!row) {
      const prior = await priorOutcome(args.tenant_id, a.question_id);
      if (a.answer === "yes" && prior.outcome === "already_answered" && prior.answer === "yes") {
        const { data: again } = await db
          .from("cgo_questions")
          .select(`${COLS}, applied_line`)
          .eq("id", a.question_id)
          .eq("tenant_id", args.tenant_id)
          .eq("status", "answered")
          .maybeSingle<Row & { applied_line: string | null }>();
        if (again && again.on_yes?.kind === "held_ad_order" && !again.applied_line) {
          out.push(await heldYes(again, "yes"));
          continue;
        }
      }
      out.push(prior);
      continue;
    }
    let applied: string | null = null;
    if (a.answer === "yes" && row.on_yes?.kind === "goal_change" && row.asked_run_id) {
      const apply = deps.applyApprovedGoalChange ?? (await import("./goal-owner")).applyApprovedGoalChange;
      applied = await apply(args.tenant_id, row.asked_run_id, row.on_yes, now).catch((e) => {
        console.warn(`[cgo-answers] applying the approved change for ${row.id} failed, the next review retries: ${(e as Error).message}`);
        return null;
      });
      if (applied) {
        const { error: lineErr } = await db.from("cgo_questions").update({ applied_line: applied.slice(0, 400) }).eq("id", row.id).eq("tenant_id", args.tenant_id);
        if (lineErr) console.warn(`[cgo-answers] recording what the yes changed failed: ${lineErr.message}`);
      }
    }
    if ((a.answer === "yes" || a.answer === "no") && row.on_yes?.kind === "goal_basis") {
      const { applyGoalBasis } = await import("./goal-basis");
      const actor = args.actor_user_id
        ? ({ source: "founder", user_id: args.actor_user_id } as const)
        : ({ source: "system", why: `The founder's ${args.via} answer` } as const);
      const onYes = row.on_yes;
      const stored = await applyGoalBasis(args.tenant_id, onYes, a.answer, actor, now).catch((e) => {
        console.warn(`[cgo-answers] storing how goal ${onYes.goal_id} counts failed, the next review retries: ${(e as Error).message}`);
        return null;
      });
      if (stored) {
        applied = stored.line;
        const { error: lineErr } = await db
          .from("cgo_questions")
          .update({ applied_line: stored.line.slice(0, 400), on_yes: { ...onYes, applied_at: stored.applied_at } })
          .eq("id", row.id)
          .eq("tenant_id", args.tenant_id);
        if (lineErr) console.warn(`[cgo-answers] recording the stored answer failed: ${lineErr.message}`);
      }
    }
    if (a.answer === "yes" && row.on_yes?.kind === "held_ad_order") {
      out.push(await heldYes(row, text));
      continue;
    }
    out.push({ question_id: row.id, outcome: "answered", ordinal: row.ordinal ?? null, ask: row.ask, answer: text, applied });
  }

  if (out.some((o) => o.outcome === "answered")) {
    const { promoteQueuedQuietly } = await import("./cgo-questions");
    await promoteQueuedQuietly(args.tenant_id, now);
  }

  const answered = out.filter(
    (o): o is Extract<AnswerOutcome, { outcome: "answered" }> => o.outcome === "answered" && !o.note && o.answer !== "not_now",
  );
  if (answered.length > 0) {
    const text = answered
      .map((o) => `Your question "${o.ask}" was answered: ${answerLabel(o.answer)}.${o.applied ? ` Already applied: ${o.applied}` : ""}`)
      .join("\n");
    const wake = deps.wake ?? wakeCgoWithAnswers;
    await wake(args.tenant_id, args.via, text, `answer:${answered.map((o) => o.question_id).sort().join(",")}`).catch((e) =>
      console.warn(`[cgo-answers] waking cgo failed (the next review reads the answer): ${(e as Error).message}`),
    );
  }
  return out;
}

export async function answerQuestion(
  args: { tenant_id: string; question_id: string; answer: Answer; via: AnswerVia; actor_user_id: string | null; now?: Date },
  deps: Deps = {},
): Promise<AnswerOutcome> {
  const [r] = await answerQuestions({ ...args, answers: [{ question_id: args.question_id, answer: args.answer }] }, deps);
  return r ?? { question_id: args.question_id, outcome: "not_found" };
}

export const ANSWER_WAKE_PERIOD = "2m";
export const ANSWER_WAKE_TIMEOUT = "5m";
export const ANSWER_WAKE_LOOKBACK_MS = 3_600_000;

export async function wakeCgoWithAnswers(tenant_id: string, via: AnswerVia, _text: string, key: string): Promise<void> {
  const { inngest } = await import("@/../workers/client");
  const question_ids = key.replace(/^answer:/, "").split(",").filter(Boolean);
  await inngest.send({ name: "cgo/answers.answered", data: { tenant_id, via, question_ids } });
}

export async function wakeCgoForRecentAnswers(
  data: { tenant_id: string; via: AnswerVia; question_ids: string[] },
  now: Date = new Date(),
): Promise<{ enqueued: boolean; skipped?: string; answers?: number }> {
  const db = tenantClient(asTenantId(data.tenant_id));
  if (!data.question_ids.length) return { enqueued: false, skipped: "no_questions" };
  const { data: own, error: ownErr } = await db.from("cgo_questions").select("id").eq("tenant_id", data.tenant_id).in("id", data.question_ids).limit(50);
  if (ownErr) throw new Error(`cgo-answers: question read failed: ${ownErr.message}`);
  if (!own?.length) return { enqueued: false, skipped: "tenant_mismatch" };
  const { data: rows, error } = await db
    .from("cgo_questions")
    .select("id, ask, answer, applied_line, answered_at")
    .eq("tenant_id", data.tenant_id)
    .eq("status", "answered")
    .is("resolved_run_id", null)
    .gte("answered_at", new Date(now.getTime() - ANSWER_WAKE_LOOKBACK_MS).toISOString())
    .order("answered_at", { ascending: true })
    .limit(20);
  if (error) throw new Error(`cgo-answers: answered questions read failed: ${error.message}`);
  const answered = ((rows ?? []) as Array<{ id: string; ask: string; answer: string | null; applied_line: string | null }>).filter((r) => r.answer && r.answer !== "not_now");
  if (!answered.length) return { enqueued: false, skipped: "nothing_to_act_on" };
  const text = answered
    .map((r) => `Your question "${r.ask}" was answered: ${answerLabel(r.answer)}.${r.applied_line ? ` Already applied: ${r.applied_line}` : ""}`)
    .join("\n");
  const { enqueueGoalOwnerRun } = await import("./goal-owner");
  const r = await enqueueGoalOwnerRun({
    tenant_id: data.tenant_id,
    reason: "founder_reply",
    founder_reply: { via: data.via, text, reply_run_id: `answer:${answered.map((a) => a.id).sort().join(",")}` },
  });
  return { enqueued: r.enqueued, ...(r.enqueued ? {} : { skipped: (r as { skipped?: string }).skipped }), answers: answered.length };
}

export async function undoAnsweredQuestion(tenant_id: string, question_id: string): Promise<string | null> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data: kindRow } = await db.from("cgo_questions").select("on_yes").eq("id", question_id).eq("tenant_id", tenant_id).maybeSingle<{ on_yes: OnYes | null }>();
  if (kindRow?.on_yes?.kind === "hypothesis_check") {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "undo_hypothesis_answer", { p_tenant_id: tenant_id, p_question_id: question_id });
    if (error) {
      console.warn(`[cgo-answers] undoing hypothesis answer ${question_id} failed: ${error.message}`);
      return null;
    }
    const r = (data ?? {}) as { outcome?: string; claim?: string };
    if (r.outcome !== "undone") return null;
    return `"${r.claim ?? "That idea"}" is open again. Any work already started from your answer keeps going.`;
  }
  const { data: q } = await db
    .from("cgo_questions")
    .select("id, on_yes, applied_line, answer")
    .eq("id", question_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle<{ id: string; on_yes: OnYes | null; applied_line: string | null; answer: string | null }>();
  if (q && q.applied_line && q.on_yes?.kind === "goal_basis" && (q.answer === "yes" || q.answer === "no")) {
    const { undoGoalBasis } = await import("./goal-basis");
    const line = await undoGoalBasis(tenant_id, q.on_yes, q.answer).catch(() => null);
    if (!line) return null;
    const { error } = await db
      .from("cgo_questions")
      .update({ applied_line: null, on_yes: { ...q.on_yes, undone_at: new Date().toISOString() } })
      .eq("id", q.id)
      .eq("tenant_id", tenant_id);
    if (error) console.warn(`[cgo-answers] clearing the undone answer failed: ${error.message}`);
    return line;
  }
  if (!q || q.answer !== "yes" || !q.applied_line || q.on_yes?.kind !== "goal_change") return null;
  const { undoGoalChange } = await import("@/routes/workspace/head-of-growth");
  const r = await undoGoalChange(tenant_id, q.on_yes.goal_id, undefined, { source: "system", why: "Undo from the founder's email reply" });
  if (!r.ok) return null;
  const { error } = await db.from("cgo_questions").update({ applied_line: null }).eq("id", q.id).eq("tenant_id", tenant_id);
  if (error) console.warn(`[cgo-answers] clearing the undone change failed: ${error.message}`);
  return `Goal "${r.objective}" is back to what it was.`;
}

export type ParsedReply =
  | { kind: "answers"; answers: Array<{ ordinal: number | "all"; answer: "yes" | "no" }> }
  | { kind: "undo"; ordinals: number[] }
  | { kind: "free" };

const YES = new Set([
  "yes", "y", "yep", "yeah", "yes please", "ok", "okay", "sure", "go ahead", "approve", "approved",
  "yes go ahead", "yes please go ahead", "ok go ahead", "okay go ahead", "sure go ahead", "yes do it", "yes go for it", "go for it",
]);
const NO = new Set(["no", "n", "nope", "no thanks", "don't", "dont", "reject"]);
function yn(w: string): "yes" | "no" | null {
  const t = w.replace(/[,;.!]+/g, " ").replace(/\s+/g, " ").trim();
  return YES.has(t) ? "yes" : NO.has(t) ? "no" : null;
}

export function parseAnswerReply(own: string): ParsedReply {
  const lines = own
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const signOff = lines.findIndex((l, i) => i > 0 && /^(?:--|(?:thanks|thank you|cheers|best|regards|sent from)\b)/.test(l));
  const t = (signOff > 0 ? lines.slice(0, signOff) : lines)
    .join(" ")
    .replace(/[.!]+$/g, "")
    .trim();
  if (!t) return { kind: "free" };

  const bare = t.replace(/\s+/g, " ");
  const allMatch = /^(?:(?:(yes|no)(?: to all| all| to both| both)?)|(?:all|both) (yes|no))$/.exec(bare);
  if (allMatch) {
    const a = yn(allMatch[1] ?? allMatch[2]);
    if (a) return { kind: "answers", answers: [{ ordinal: "all", answer: a }] };
  }
  if (yn(bare)) return { kind: "answers", answers: [{ ordinal: "all", answer: yn(bare)! }] };

  const undo = /^undo\s+(\d{1,2}(?:\s*(?:,|and|&)\s*\d{1,2})*)$/.exec(bare);
  if (undo) return { kind: "undo", ordinals: [...new Set(undo[1].split(/\s*(?:,|and|&)\s*/).map(Number))] };

  const pair = /^\s*(?:q|#)?(\d{1,2})\s*[:.)\-=]?\s*(yes|y|yep|yeah|no|n|nope|ok|okay)\b\s*(?:,|;|&|and\b)?\s*/;
  const answers = new Map<number, "yes" | "no">();
  let rest = bare;
  while (rest.length > 0) {
    const m = pair.exec(rest);
    if (!m) return { kind: "free" };
    const n = Number(m[1]);
    const a = yn(m[2]);
    if (!a || n < 1) return { kind: "free" };
    if (answers.has(n) && answers.get(n) !== a) return { kind: "free" };
    answers.set(n, a);
    rest = rest.slice(m[0].length);
  }
  if (answers.size === 0) return { kind: "free" };
  return { kind: "answers", answers: [...answers].map(([ordinal, answer]) => ({ ordinal, answer })) };
}

export function mapAnswers(
  parsed: Extract<ParsedReply, { kind: "answers" }>,
  candidates: Array<{ id: string; ordinal: number | null }>,
): Array<{ question_id: string; answer: "yes" | "no" }> | null {
  if (candidates.length === 0) return null;
  const all = parsed.answers.find((a) => a.ordinal === "all");
  if (all) return candidates.map((c) => ({ question_id: c.id, answer: all.answer }));
  const out: Array<{ question_id: string; answer: "yes" | "no" }> = [];
  for (const a of parsed.answers) {
    const hits = candidates.filter((c) => c.ordinal === a.ordinal);
    if (hits.length !== 1) return null;
    out.push({ question_id: hits[0].id, answer: a.answer });
  }
  return out;
}

export function confirmationText(outcomes: AnswerOutcome[], undone: string[] = []): string {
  const lines: string[] = [];
  const got = outcomes.filter((o): o is Extract<AnswerOutcome, { outcome: "answered" }> => o.outcome === "answered");
  for (const o of got) if (o.note) lines.push(`${o.ordinal != null ? `${o.ordinal}: ` : ""}${o.note}`);
  const taken = got.filter((o) => !o.note);
  if (taken.length > 0) {
    lines.push(`Got it: ${taken.map((o) => `${o.ordinal ?? "?"} = ${answerLabel(o.answer)}`).join(", ")}.`);
    for (const o of taken) if (o.applied) lines.push(`${o.applied}`);
  }
  for (const o of outcomes) {
    if (o.outcome === "closed") lines.push(`${o.ordinal ?? "That question"} is no longer open: nothing changed.`);
    if (o.outcome === "already_answered") {
      lines.push(`${o.ordinal ?? "That question"} was already answered: ${answerLabel(o.answer)}${o.via ? ` via ${o.via === "web" ? "the web" : o.via === "slack" ? "Slack" : "email"}` : ""}.`);
    }
  }
  lines.push(...undone);
  const undoable = got.filter((o) => o.applied && o.ordinal != null && o.undoable !== false).map((o) => o.ordinal);
  if (undoable.length > 0) lines.push(`Reply \`undo ${undoable[0]}\` to reverse ${undoable.length > 1 ? "a change" : "it"}.`);
  if (got.some((o) => !o.note)) lines.push("I'm acting on your answers now and will tell you what I change.");
  return lines.join("\n");
}

export function deferredWake(): { wake: NonNullable<Deps["wake"]>; run: () => Promise<void> } {
  let pending: (() => Promise<void>) | null = null;
  return {
    wake: async (t, v, x, k) => {
      pending = () => wakeCgoWithAnswers(t, v, x, k);
    },
    run: async () => {
      if (!pending) return;
      await pending().catch((e) => console.warn(`[cgo-answers] waking cgo failed (the next review reads the answer): ${(e as Error).message}`));
    },
  };
}
