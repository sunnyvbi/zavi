import { adChangeHeadline, adChangeMoney } from "@zavi/shared";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { cutStillHolds, decisionLegState, legDailyAdd, legSide, moveGroupOf, readMoveGroup, readOrderLiveness, UNKNOWN_ORDER_PREFIX, type LegSide, type LegState, type LiveReader } from "./move-group";
import type { FounderCutPick, NewCut } from "./founder-cut-candidates";

export const RAISE_GROUP = "raise:";
export const FOUND_FOR_RAISE = "found_for_raise";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function moveKeyOf(body: unknown): string | null {
  const g = obj(body).move_group;
  if (typeof g === "string" && g.startsWith(RAISE_GROUP) && UUID.test(g.slice(RAISE_GROUP.length))) return g;
  return moveGroupOf(body);
}

export type MoveAfter = { cut_ids: string[]; by: string; at: string; budget_to_usd: number | null; daily_limit_to_usd: number | null; blocked?: { code: string; at: string } };

export function moveAfterOf(body: unknown): MoveAfter | null {
  const m = obj(obj(body).move_after);
  if (!Array.isArray(m.cut_ids) || !m.cut_ids.length || !m.cut_ids.every((x) => typeof x === "string" && UUID.test(x)) || typeof m.by !== "string") return null;
  const blocked = obj(m.blocked);
  return {
    cut_ids: m.cut_ids as string[],
    by: m.by,
    at: String(m.at ?? ""),
    budget_to_usd: typeof m.budget_to_usd === "number" ? m.budget_to_usd : null,
    daily_limit_to_usd: typeof m.daily_limit_to_usd === "number" ? m.daily_limit_to_usd : null,
    ...(typeof blocked.code === "string" ? { blocked: { code: blocked.code, at: String(blocked.at ?? "") } } : {}),
  };
}

export function rewireCutIds(after: MoveAfter, oldId: string, newId: string): MoveAfter {
  const { blocked: _b, ...rest } = after;
  return { ...rest, cut_ids: after.cut_ids.map((x) => (x === oldId ? newId : x)) };
}

const WAITING = new Set(["proposed", "approved", "dispatching"]);
const MAY_HAVE_APPLIED = new Set(["acted", "dispatch_failed"]);

export function cutsVerdict(rows: ReadonlyArray<{ id: string; status: string }>, cutIds: readonly string[], holds: ReadonlySet<string>): "wait" | "go" | { stop: string[] } {
  const st = new Map(rows.map((r) => [r.id, r.status]));
  if (cutIds.some((id) => WAITING.has(st.get(id) ?? ""))) return "wait";
  const stop = cutIds.filter((id) => !MAY_HAVE_APPLIED.has(st.get(id) ?? "") || !holds.has(id));
  return stop.length ? { stop } : "go";
}

export async function checkMoveAfter(tenant_id: string, body: unknown, live?: LiveReader): Promise<"wait" | "go" | { stop: string[] }> {
  const after = moveAfterOf(body);
  if (!after) return "go";
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id)).from("decisions").select("id, decision_class, body, status").eq("tenant_id", tenant_id).in("id", after.cut_ids);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ id: string; decision_class: string; body: unknown; status: string }>;
    const neutral = new Set(rows.filter((r) => legSide(r.decision_class, r.body) !== "lowers").map((r) => r.id));
    const prereq = after.cut_ids.filter((id) => !neutral.has(id));
    if (!prereq.length) return "go";
    const holds = new Set<string>();
    for (const r of rows) if (!neutral.has(r.id) && MAY_HAVE_APPLIED.has(r.status) && (await cutStillHolds(tenant_id, { exec_class: r.decision_class, body: r.body }, live))) holds.add(r.id);
    return cutsVerdict(rows, prereq, holds);
  } catch (e) {
    console.warn(`[move-card] cuts of a move could not be read; the raise stops: ${(e as Error).message}`);
    return { stop: after.cut_ids };
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const LINE_PAGE = 50;

export type MoveLine = { id: string; exec_class: string; body: unknown; status: string; state: LegState; side: LegSide; daily_delta: number | null; agent_run_id: string | null; dispatch_error: string | null };
export type MovePlan = { ok: true; cuts: MoveLine[]; adds: MoveLine[]; net_daily_usd: number } | { ok: false; code: "not_in_move" | "not_open" | "amount_unknown" | "nothing_ticked"; line?: string };

export function planMove(lines: readonly MoveLine[], ticked: readonly string[]): MovePlan {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const picked: MoveLine[] = [];
  for (const id of new Set(ticked)) {
    const l = byId.get(id);
    if (!l) return { ok: false, code: "not_in_move", line: id };
    if (l.state !== "open") return { ok: false, code: "not_open", line: id };
    picked.push(l);
  }
  if (!picked.length) return { ok: false, code: "nothing_ticked" };
  const adds = picked.filter((l) => l.side === "adds");
  const cuts = picked.filter((l) => l.side !== "adds");
  const unknown = adds.find((l) => !(typeof l.daily_delta === "number" && l.daily_delta > 0));
  if (unknown) return { ok: false, code: "amount_unknown", line: unknown.id };
  const net = adds.reduce((s, l) => s + (l.daily_delta as number), 0) + cuts.reduce((s, l) => s + Math.min(0, l.daily_delta ?? 0), 0);
  return { ok: true, cuts, adds, net_daily_usd: round2(net) };
}

function anchorKey(id: string, body: unknown): string | null {
  return moveKeyOf(body) ?? (moveAfterOf(body) ? `${RAISE_GROUP}${id}` : null);
}

type DecisionRead = { id: string; decision_class: string; body: unknown; status: string; agent_run_id: string | null; dispatch_error: string | null };
const COLS = "id, decision_class, body, status, agent_run_id, dispatch_error";

async function readDecision(tenant_id: string, id: string): Promise<DecisionRead | null> {
  if (!UUID.test(id)) return null;
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("decisions").select(COLS).eq("tenant_id", tenant_id).eq("id", id).maybeSingle();
  if (error) throw new Error(`move card read failed: ${error.message}`);
  return (data as DecisionRead | null) ?? null;
}

export async function readMoveLines(tenant_id: string, key: string, live?: LiveReader): Promise<MoveLine[]> {
  const db = tenantClient(asTenantId(tenant_id));
  const raiseId = key.startsWith(RAISE_GROUP) ? key.slice(RAISE_GROUP.length) : null;
  if (raiseId !== null && !UUID.test(raiseId)) return [];
  let q = db.from("decisions").select(COLS).eq("tenant_id", tenant_id);
  q = raiseId ? q.or(`id.eq.${raiseId},body->>move_group.eq."${key}"`) : q.eq("body->>move_group", key);
  const { data, error } = await q.limit(LINE_PAGE);
  if (error) throw new Error(`move lines read failed: ${error.message}`);
  const rows = ((data ?? []) as DecisionRead[]).filter((r) => r.id === raiseId || moveKeyOf(r.body) === key);
  if (rows.length >= LINE_PAGE) throw new Error("move larger than one page");
  const retried = new Set(rows.map((r) => obj(r.body).retry_of).filter((x): x is string => typeof x === "string"));
  const out: MoveLine[] = [];
  for (const r of rows) {
    if (retried.has(r.id)) continue;
    const side = legSide(r.decision_class, r.body);
    let daily_delta = adChangeMoney(r.decision_class, r.body)?.delta ?? null;
    if (side === "adds" && daily_delta === null && r.status === "proposed") daily_delta = (await legDailyAdd(tenant_id, { id: r.id, exec_class: r.decision_class, body: r.body }, live)).daily;
    out.push({ id: r.id, exec_class: r.decision_class, body: r.body, status: r.status, state: decisionLegState(r.status), side, daily_delta, agent_run_id: r.agent_run_id ?? null, dispatch_error: r.dispatch_error ?? null });
  }
  return out;
}

async function onBothRails(tenant_id: string, key: string): Promise<boolean> {
  if (key.startsWith(RAISE_GROUP) || key.startsWith(UNKNOWN_ORDER_PREFIX)) return false;
  return (await readMoveGroup(tenant_id, key)).some((l) => l.table !== "decisions");
}

async function filingState(tenant_id: string, key: string, lines: readonly MoveLine[], anchor: { id: string; agent_run_id: string | null }): Promise<"quiet" | "filing" | "unknown"> {
  if (key.startsWith(RAISE_GROUP)) return "quiet";
  if (key.startsWith(UNKNOWN_ORDER_PREFIX)) return "unknown";
  const live = await readOrderLiveness(tenant_id, key, lines.map((l) => l.agent_run_id), anchor.agent_run_id, anchor.id);
  return live === "quiet" ? "quiet" : "filing";
}

async function writeMoveAfter(tenant_id: string, actor: string, row: { id: string; body: unknown }, after: MoveAfter | null): Promise<boolean> {
  const { move_after: _old, ...rest } = obj(row.body);
  const body = after ? { ...rest, move_after: after } : rest;
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "edit_decision_body_if_proposed", { p_decision_id: row.id, p_actor_user_id: actor, p_body: body });
  if (error || (data as { ok?: boolean } | null)?.ok !== true) {
    console.warn(`[move-card] move_after of ${row.id} not written: ${error?.message ?? JSON.stringify(data)}`);
    return false;
  }
  return true;
}

async function findOrFileClone(tenant_id: string, row: DecisionRead, dropBudgetChoice: boolean): Promise<{ id: string; status: string } | null> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data, error } = await db.from("decisions").select("id, status").eq("tenant_id", tenant_id).eq("body->>retry_of", row.id).limit(10);
  if (error) throw new Error(`retry clone read failed: ${error.message}`);
  const open = ((data ?? []) as Array<{ id: string; status: string }>).find((r) => !["rejected", "expired", "superseded"].includes(r.status));
  if (open) return open;
  const { budget_choice: _bc, ...rest } = obj(row.body);
  const body = { ...(dropBudgetChoice ? rest : obj(row.body)), retry_of: row.id };
  const r = await tenantRpc(asTenantId(tenant_id), "emit_decision", { p_agent_run_id: row.agent_run_id, p_decision_class: row.decision_class, p_body: body });
  if (r.error || typeof r.data !== "string") {
    console.warn(`[move-card] retry of ${row.id} not filed: ${r.error?.message ?? "no id"}`);
    return null;
  }
  return { id: r.data, status: "proposed" };
}

type DecideArgs = Parameters<typeof import("@/services/approvals/decide-service").decideOnDecision>[0];
async function decide(a: Omit<DecideArgs, "action"> & { action?: DecideArgs["action"] }) {
  const { decideOnDecision } = await import("@/services/approvals/decide-service");
  return decideOnDecision({ action: "approve", ...a } as DecideArgs);
}

export type ApproveMoveArgs = {
  tenant_id: string;
  actor_user_id: string;
  anchor_id: string;
  ticked_ids: readonly string[];
  raise_budget_to_usd?: number;
  raise_daily_limit_to_usd?: number;
  retry_ids?: readonly string[];
  finish?: boolean;
  new_cuts?: readonly NewCut[];
  live?: LiveReader;
};
export type MoveCode =
  | "move_off" | "move_mixed_rails" | "not_in_move" | "not_open" | "amount_unknown" | "nothing_ticked" | "move_still_filing" | "move_unreadable" | "not_authorized"
  | "move_cut_refused" | "move_waits_on_cuts" | "rpc_error" | "budget_unreadable" | "budget_choice_required" | "budget_raise_changed" | "budget_raise_failed"
  | "budget_choice_in_zavi" | "decision_closed" | "card_changed" | "candidates_changed" | "move_cut_file_failed" | string;
export type ApproveMoveResult =
  | { ok: true; approved: string[]; waiting: string[] }
  | { ok: false; code: MoveCode; detail?: string; line_id?: string; done?: string[]; budget_choice?: unknown; filed?: string[]; candidates?: FounderCutPick[] };

const fail = (code: MoveCode, extra: Omit<Extract<ApproveMoveResult, { ok: false }>, "ok" | "code"> = {}): ApproveMoveResult => ({ ok: false, code, ...extra });
const partial = (r: ApproveMoveResult, approved: string[]): ApproveMoveResult => {
  if (r.ok || !approved.length) return r;
  const why = (r.detail ?? "").replace(/\s*Nothing was approved\.?/g, "").trim();
  const head = approved.length === 1 ? "One change in this move was approved; the rest was not." : `${approved.length} changes in this move were approved; the rest was not.`;
  return { ...r, done: approved, detail: why ? `${head} ${why}` : head };
};
const WAITS_WORDS = { wait: "The cuts in this move are still being applied. The raise runs after them.", stop: "A cut this raise needs did not go through, so the raise has not run. Retry the cut or reject the move." };

async function approveRaise(a: ApproveMoveArgs, raise: { id: string; body: unknown }, ask: { raise_budget_to_usd?: number; raise_daily_limit_to_usd?: number }, extra: Partial<DecideArgs> = {}): Promise<ApproveMoveResult | null> {
  if (moveAfterOf(raise.body)) {
    const v = await checkMoveAfter(a.tenant_id, raise.body, a.live);
    if (v !== "go") return fail("move_waits_on_cuts", { detail: v === "wait" ? WAITS_WORDS.wait : WAITS_WORDS.stop, line_id: raise.id });
  }
  const r = await decide({ decision_id: raise.id, tenant_id: a.tenant_id, actor: { user_id: a.actor_user_id }, surface: "web", ...ask, ...extra });
  if (!r.ok) return fail(r.code, { detail: r.detail, line_id: raise.id, ...(r.budget_choice !== undefined ? { budget_choice: r.budget_choice } : {}) });
  return null;
}

export async function approveMove(a: ApproveMoveArgs): Promise<ApproveMoveResult> {
  const { adBudgetChoiceEnabled } = await import("@/services/decisions/ad-budget-choice-flag");
  if (!(await adBudgetChoiceEnabled())) return fail("move_off");
  const ask = {
    ...(a.raise_budget_to_usd !== undefined ? { raise_budget_to_usd: a.raise_budget_to_usd } : {}),
    ...(a.raise_daily_limit_to_usd !== undefined ? { raise_daily_limit_to_usd: a.raise_daily_limit_to_usd } : {}),
  };
  if (a.new_cuts?.length) {
    if ((a.retry_ids ?? []).length || a.finish === true) return fail("invalid_new_cuts", { detail: "New cuts come with an Approve, not a Retry or Finish. Nothing was approved." });
    const filed = await fileNewCuts(a, ask);
    if (!filed.ok) return filed.r;
    const r = await approveMove({ ...a, ticked_ids: [...a.ticked_ids, ...filed.ids], new_cuts: undefined });
    if (r.ok) return r;
    const told = r.done?.length ? partial(r, r.done) : r;
    if (told.ok) return told;
    const detail = told.done?.length ? told.detail : `${(told.detail ?? "").replace(/\s*Nothing was approved\.?/g, "").trim()} None is approved yet: the cuts you picked are filed on the card.`.trim();
    return { ...told, detail, filed: [...new Set([...(r.filed ?? []), ...filed.ids])] };
  }
  let anchor: DecisionRead | null;
  let lines: MoveLine[];
  let key: string | null;
  try {
    anchor = await readDecision(a.tenant_id, a.anchor_id);
    key = anchor ? anchorKey(anchor.id, anchor.body) : null;
    if (!anchor || !key) return fail("not_in_move");
    lines = await readMoveLines(a.tenant_id, key, a.live);
    if (await onBothRails(a.tenant_id, key)) return fail("move_mixed_rails", { detail: "Part of this move is a channel card, so approve each card on its own. Nothing was approved." });
    const filing = await filingState(a.tenant_id, key, lines, anchor);
    if (filing === "filing") return fail("move_still_filing", { detail: "Zavi is still filing this move. Approve it once the reply finishes." });
    if (filing === "unknown") return fail("move_unreadable", { detail: "Zavi could not tell which request this move belongs to, so it cannot approve it as one. Reject it and ask again." });
  } catch (e) {
    console.warn(`[move-card] move of ${a.anchor_id} unreadable: ${(e as Error).message}`);
    return fail("move_unreadable", { detail: "Zavi could not read this move just now. Nothing was approved. Try again." });
  }
  const byId = new Map(lines.map((l) => [l.id, l]));
  const raises = lines.filter((l) => l.side === "adds");

  const addsSpend = (a.retry_ids ?? []).length > 0 || a.finish === true || a.ticked_ids.some((id) => byId.get(id)?.side === "adds");
  if (addsSpend) {
    const { loadTenantRoleFor } = await import("@/services/auth/tenant-role");
    const role = await loadTenantRoleFor(a.actor_user_id, a.tenant_id).catch(() => null);
    if (role !== "owner" && role !== "admin") return fail("not_authorized", { detail: "Only an owner or admin can approve a change that adds ad spend." });
  }

  for (const id of a.retry_ids ?? []) {
    const line = byId.get(id);
    if (!line) {
      const clone = lines.find((l) => obj(l.body).retry_of === id);
      if (!clone) return fail("not_in_move", { line_id: id });
      const dependents = raises.filter((r) => r.status === "proposed" && moveAfterOf(r.body)?.cut_ids.some((c) => c === id || c === clone.id));
      for (const r of dependents) {
        const after = moveAfterOf(r.body)!;
        if (after.cut_ids.includes(clone.id)) continue;
        if (!(await writeMoveAfter(a.tenant_id, a.actor_user_id, r, rewireCutIds(after, id, clone.id)))) return fail("rpc_error", { line_id: r.id, detail: "Zavi could not update the move. Nothing was approved." });
      }
      if (clone.status !== "proposed") return { ok: true, approved: [], waiting: dependents.map((r) => r.id) };
      if (clone.side === "adds") {
        const refused = await approveRaise(a, clone, { ...recordedAsk(moveAfterOf(clone.body)), ...ask });
        return refused ?? { ok: true, approved: [clone.id], waiting: [] };
      }
      const r = await decide({ decision_id: clone.id, tenant_id: a.tenant_id, actor: { user_id: a.actor_user_id }, surface: "web" });
      if (!r.ok) return fail("move_cut_refused", { line_id: clone.id, detail: r.detail, done: [] });
      return { ok: true, approved: [clone.id], waiting: dependents.map((x) => x.id) };
    }
    if (line.status !== "dispatch_failed") return fail("not_open", { line_id: id, detail: "Only a change that did not go through can be retried." });
    const row = { id: line.id, decision_class: line.exec_class, body: line.body, status: line.status, agent_run_id: line.agent_run_id, dispatch_error: line.dispatch_error };
    if (line.side !== "adds") {
      const dependents = raises.filter((r) => r.status === "proposed" && moveAfterOf(r.body)?.cut_ids.includes(id));
      if (await cutStillHolds(a.tenant_id, { exec_class: line.exec_class, body: line.body }, a.live)) return { ok: true, approved: [], waiting: dependents.map((r) => r.id) };
      let clone: { id: string; status: string } | null;
      try {
        clone = await findOrFileClone(a.tenant_id, row, true);
      } catch (e) {
        console.warn(`[move-card] retry clone of ${id} unreadable: ${(e as Error).message}`);
        return fail("move_unreadable");
      }
      if (!clone) return fail("rpc_error", { line_id: id, detail: "Zavi could not file the retry. Nothing was approved." });
      for (const r of dependents) {
        const after = moveAfterOf(r.body)!;
        if (after.cut_ids.includes(clone.id)) continue;
        if (!(await writeMoveAfter(a.tenant_id, a.actor_user_id, r, rewireCutIds(after, id, clone.id)))) return fail("rpc_error", { line_id: r.id, detail: "Zavi could not update the move. Nothing was approved." });
      }
      if (clone.status !== "proposed") return { ok: true, approved: [], waiting: dependents.map((r) => r.id) };
      const r = await decide({ decision_id: clone.id, tenant_id: a.tenant_id, actor: { user_id: a.actor_user_id }, surface: "web" });
      if (!r.ok) return fail("move_cut_refused", { line_id: clone.id, detail: r.detail, done: [] });
      return { ok: true, approved: [clone.id], waiting: dependents.map((x) => x.id) };
    }
    let clone: { id: string; status: string } | null;
    try {
      clone = await findOrFileClone(a.tenant_id, row, true);
    } catch (e) {
      console.warn(`[move-card] retry clone of ${id} unreadable: ${(e as Error).message}`);
      return fail("move_unreadable");
    }
    if (!clone) return fail("rpc_error", { line_id: id, detail: "Zavi could not file the retry. Nothing was approved." });
    if (clone.status !== "proposed") return { ok: true, approved: [], waiting: [] };
    const after = moveAfterOf(line.body);
    const cloneBody = { ...obj(line.body), retry_of: line.id };
    const refused = await approveRaise(a, { id: clone.id, body: cloneBody }, { ...recordedAsk(after), ...ask });
    return refused ?? { ok: true, approved: [clone.id], waiting: [] };
  }

  if (a.finish === true) {
    const ready = raises.filter((r) => r.state === "open" && moveAfterOf(r.body));
    if (!ready.length) return fail("nothing_ticked", { detail: "There is no raise waiting to finish." });
    const approved: string[] = [];
    for (const r of ready) {
      const refused = await approveRaise(a, r, { ...recordedAsk(moveAfterOf(r.body)), ...ask });
      if (refused) return partial(refused, approved);
      approved.push(r.id);
    }
    return { ok: true, approved, waiting: [] };
  }

  const ticked = [...new Set(a.ticked_ids)].map((id) => byId.get(id));
  if (ticked.length && ticked.every((l) => l && l.state !== "open" ? l.side !== "adds" : !!l && l.side === "adds")) {
    const tCuts = ticked.filter((l) => l!.side === "lowers").map((l) => l!.id);
    const tRaises = ticked.filter((l) => l!.side === "adds");
    const replay = tCuts.length > 0 && tCuts.every((id) => ["approved", "dispatching", "acted"].includes(byId.get(id)!.status)) &&
      tRaises.every((r) => { const m = moveAfterOf(r!.body); return !!m && tCuts.every((c) => m.cut_ids.includes(c)) && m.cut_ids.length === tCuts.length; });
    if (replay) return { ok: true, approved: [], waiting: tRaises.map((r) => r!.id) };
  }

  const plan = planMove(lines, a.ticked_ids);
  if (!plan.ok) return fail(plan.code, plan.line ? { line_id: plan.line } : {});

  if (plan.cuts.length && plan.adds.length && plan.net_daily_usd > 0) {
    const fit = await netFit(a.tenant_id, plan.net_daily_usd);
    const { budgetChoiceRefusal } = await import("@/services/approvals/budget-choice");
    const r = budgetChoiceRefusal(fit, "web", ask);
    if (r) return fail(r.code, { detail: r.detail, budget_choice: fit });
  }

  const prereq = plan.cuts.filter((c) => c.side === "lowers");

  if (!prereq.length) {
    const approved: string[] = [];
    for (const c of plan.cuts) {
      const r = await decide({ decision_id: c.id, tenant_id: a.tenant_id, actor: { user_id: a.actor_user_id }, surface: "web" });
      if (!r.ok) return fail("move_cut_refused", { line_id: c.id, detail: r.detail, done: approved });
      approved.push(c.id);
    }
    for (const r of plan.adds) {
      const alone = !moveAfterOf(r.body) && moveGroupOf(r.body) !== null;
      const refused = await approveRaise(a, r, ask, alone ? { run_alone: true } : {});
      if (refused) return partial(refused, approved);
      approved.push(r.id);
    }
    return { ok: true, approved, waiting: [] };
  }

  const at = new Date().toISOString();
  const cut_ids = prereq.map((c) => c.id);
  for (const r of plan.adds) {
    const after: MoveAfter = { cut_ids, by: a.actor_user_id, at, budget_to_usd: a.raise_budget_to_usd ?? null, daily_limit_to_usd: a.raise_daily_limit_to_usd ?? null };
    if (!(await writeMoveAfter(a.tenant_id, a.actor_user_id, r, after))) return fail("rpc_error", { line_id: r.id, detail: "Zavi could not save the move. Nothing was approved." });
  }
  const done: string[] = [];
  for (const c of plan.cuts) {
    const r = await decide({ decision_id: c.id, tenant_id: a.tenant_id, actor: { user_id: a.actor_user_id }, surface: "web" });
    if (!r.ok) return fail("move_cut_refused", { line_id: c.id, detail: r.detail, done });
    done.push(c.id);
  }
  return { ok: true, approved: done, waiting: plan.adds.map((r) => r.id) };
}

async function fileNewCuts(a: ApproveMoveArgs, ask: { raise_budget_to_usd?: number; raise_daily_limit_to_usd?: number }): Promise<{ ok: true; ids: string[] } | { ok: false; r: ApproveMoveResult }> {
  const no = (code: MoveCode, extra: Omit<Extract<ApproveMoveResult, { ok: false }>, "ok" | "code"> = {}) => ({ ok: false as const, r: fail(code, extra) });
  let raise: DecisionRead | null;
  let lines: MoveLine[];
  try {
    raise = await readDecision(a.tenant_id, a.anchor_id);
    if (!raise) return no("not_in_move");
    if (raise.status !== "proposed" || legSide(raise.decision_class, raise.body) !== "adds") return no("not_open", { line_id: raise.id, detail: "Zavi finds money elsewhere only for an open raise. Nothing was approved." });
    lines = await readMoveLines(a.tenant_id, anchorKey(raise.id, raise.body) ?? `${RAISE_GROUP}${raise.id}`, a.live);
  } catch (e) {
    console.warn(`[move-card] raise ${a.anchor_id} unreadable: ${(e as Error).message}`);
    return no("move_unreadable", { detail: "Zavi could not read this card just now. Nothing was approved. Try again." });
  }
  const { loadTenantRoleFor } = await import("@/services/auth/tenant-role");
  const role = await loadTenantRoleFor(a.actor_user_id, a.tenant_id).catch(() => null);
  if (role !== "owner" && role !== "admin") return no("not_authorized", { detail: "Only an owner or admin can approve a change that adds ad spend." });
  const { findMoneyFor, picksMatch } = await import("./founder-cut-candidates");
  const fresh = await findMoneyFor(a.tenant_id, { id: raise.id, decision_class: raise.decision_class, body: raise.body });
  if (fresh.kind === "unreadable") return no("budget_unreadable", { detail: `Zavi can't check your ad budget right now (${fresh.why}), so nothing was approved. Try again later.`, budget_choice: fresh.budget_choice });
  const picks = picksMatch(a.new_cuts ?? [], fresh.candidates);
  if (!picks) return no("candidates_changed", { detail: "The cuts Zavi found have changed. Check the new list and approve again. Nothing was approved.", candidates: fresh.candidates });
  const plan = planMove(lines, a.ticked_ids);
  if (!plan.ok && plan.code !== "nothing_ticked") return no(plan.code, plan.line ? { line_id: plan.line } : {});
  const delta = plan.ok ? plan.net_daily_usd : 0;
  if (delta > 0) {
    const fit = await counterCutFit(a.tenant_id, delta, picks.reduce((s, p) => s + p.frees_daily_usd, 0));
    const { budgetChoiceRefusal } = await import("@/services/approvals/budget-choice");
    const r = budgetChoiceRefusal(fit, "web", ask);
    if (r) return no(r.code, { detail: r.detail, budget_choice: fit });
  }
  const group = moveKeyOf(raise.body) ?? `${RAISE_GROUP}${raise.id}`;
  if (moveKeyOf(raise.body) === null) {
    const { data, error } = await tenantRpc(asTenantId(a.tenant_id), "edit_decision_body_if_proposed", { p_decision_id: raise.id, p_actor_user_id: a.actor_user_id, p_body: { ...obj(raise.body), move_group: group } });
    if (error || (data as { ok?: boolean } | null)?.ok !== true) return no("rpc_error", { line_id: raise.id, detail: "Zavi could not save the move. Nothing was approved." });
  }
  const { fileFounderCut } = await import("./founder-cut-candidates");
  const ids: string[] = [];
  for (const p of picks) {
    try {
      ids.push(await fileFounderCut(a.tenant_id, p, group, raise.id));
    } catch (e) {
      const why = (e as Error).message.slice(0, 200);
      console.warn(`[move-card] cut of ${p.platform}:${p.object_id} for ${raise.id} not filed: ${why}`);
      const n = ids.length;
      return no("move_cut_file_failed", {
        filed: ids,
        line_id: raise.id,
        detail: n
          ? `Zavi filed ${n === 1 ? "one" : n} of the cuts you picked, then could not file the rest (${why}). None is approved yet: the filed ${n === 1 ? "cut is" : "cuts are"} on the card for you to tick.`
          : `Zavi could not file the cut you picked (${why}). Nothing was approved.`,
      });
    }
  }
  return { ok: true, ids };
}

async function counterCutFit(tenant_id: string, deltaDaily: number, freedDaily: number) {
  const { budgetChoiceView } = await import("@/services/approvals/budget-choice");
  try {
    const { readMonthCount } = await import("@/services/decisions/ad-month-counter");
    const { fitWithCounterCuts } = await import("./founder-cut-candidates");
    const m = await readMonthCount(tenant_id);
    if (!m) return null;
    if ("unreadable" in m) return budgetChoiceView({ kind: "unreadable", why: m.unreadable });
    return budgetChoiceView(fitWithCounterCuts(m, deltaDaily, freedDaily));
  } catch (e) {
    console.warn(`[move-card] fit with cuts unreadable for ${tenant_id}: ${(e as Error).message}`);
    return budgetChoiceView({ kind: "unreadable", why: "read" });
  }
}

function recordedAsk(after: MoveAfter | null): { raise_budget_to_usd?: number; raise_daily_limit_to_usd?: number } {
  return {
    ...(after?.budget_to_usd != null ? { raise_budget_to_usd: after.budget_to_usd } : {}),
    ...(after?.daily_limit_to_usd != null ? { raise_daily_limit_to_usd: after.daily_limit_to_usd } : {}),
  };
}

async function netFit(tenant_id: string, net: number) {
  const { budgetChoiceView } = await import("@/services/approvals/budget-choice");
  try {
    const { readMonthCount, fitDailyChange } = await import("@/services/decisions/ad-month-counter");
    const m = await readMonthCount(tenant_id);
    if (!m) return null;
    if ("unreadable" in m) return budgetChoiceView({ kind: "unreadable", why: m.unreadable });
    return budgetChoiceView(fitDailyChange(m.count, m.view, m.live_held_daily_usd, net));
  } catch (e) {
    console.warn(`[move-card] move fit unreadable for ${tenant_id}: ${(e as Error).message}`);
    return budgetChoiceView({ kind: "unreadable", why: "read" });
  }
}

async function tell(tenant_id: string, id: string, what: string, meanwhile: string): Promise<void> {
  const { alertFounderSafely } = await import("./cgo-blockers");
  await alertFounderSafely(tenant_id, "move card", [
    { id, kind: "card", who: "you", what, since: new Date().toISOString(), usd_at_stake: null, at_risk_now: false, notify_now: true, meanwhile },
  ]);
}

export async function tellMoveStopped(tenant_id: string, raise_id: string): Promise<void> {
  await tell(tenant_id, `move_cut_failed:${raise_id}`, "A cut in your move did not go through, so its raise has not run. Open the move card to retry the cut or reject the move.", "your spend did not go up");
}

export async function tellRaiseFailed(tenant_id: string, raise: { id: string; decision_class: string; body: unknown }, sent: "never" | "unknown"): Promise<void> {
  if (sent === "never") {
    await tell(tenant_id, `move_raise_failed:${raise.id}`, "The cuts in your move went through, but the raise did not run. Open the move card to retry it.", "your spend did not go up");
    return;
  }
  await tell(tenant_id, `move_raise_failed:${raise.id}`, "Zavi could not confirm whether the raise went through. Check the ad account before you retry.", "the cuts in your move stay in place");
}

export async function advanceMove(tenant_id: string, settled_id: string, live?: LiveReader): Promise<void> {
  try {
    if (!UUID.test(settled_id)) return;
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("decisions")
      .select(COLS)
      .eq("tenant_id", tenant_id)
      .eq("status", "proposed")
      .contains("body", { move_after: { cut_ids: [settled_id] } })
      .limit(LINE_PAGE);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as DecisionRead[]) {
      const after = moveAfterOf(r.body);
      if (!after || !after.cut_ids.includes(settled_id)) continue;
      const v = await checkMoveAfter(tenant_id, r.body, live);
      if (v === "wait") continue;
      if (v !== "go") {
        await writeMoveAfter(tenant_id, after.by, r, { ...after, blocked: { code: "cut_failed", at: new Date().toISOString() } });
        await tellMoveStopped(tenant_id, r.id);
        continue;
      }
      const res = await decide({ decision_id: r.id, tenant_id, actor: { user_id: after.by }, surface: "web", ...recordedAsk(after) });
      if (!res.ok) {
        await writeMoveAfter(tenant_id, after.by, r, { ...after, blocked: { code: res.code, at: new Date().toISOString() } });
        await tell(tenant_id, `move_needs_choice:${r.id}`, "The cuts in your move are done, but the raise needs a new budget choice. Open the card.", "your spend did not go up");
      }
    }
  } catch (e) {
    console.warn(`[move-card] move after ${settled_id} not advanced: ${(e as Error).message}`);
  }
}

export type RejectMoveResult = { ok: true; rejected: string[]; kept: string[]; closed: Array<{ id: string; title: string; status: string }> } | { ok: false; code: MoveCode; detail?: string };

export async function rejectMove(tenant_id: string, actor_user_id: string, anchor_id: string): Promise<RejectMoveResult> {
  let lines: MoveLine[];
  let key: string | null;
  try {
    const anchor = await readDecision(tenant_id, anchor_id);
    key = anchor ? anchorKey(anchor.id, anchor.body) : null;
    if (!anchor || !key) return { ok: false, code: "not_in_move" };
    lines = await readMoveLines(tenant_id, key);
  } catch (e) {
    console.warn(`[move-card] move of ${anchor_id} unreadable: ${(e as Error).message}`);
    return { ok: false, code: "move_unreadable" };
  }
  const rejected: string[] = [];
  const closed: Array<{ id: string; title: string; status: string }> = [];
  for (const l of lines.filter((x) => x.state === "open")) {
    const r = await decide({ decision_id: l.id, tenant_id, actor: { user_id: actor_user_id }, action: "reject" });
    if (r.ok && r.status === "rejected") rejected.push(l.id);
    else if (r.status && r.status !== "proposed") closed.push({ id: l.id, title: adChangeHeadline(l.exec_class, l.body) ?? "A change in your move", status: r.status });
  }
  const kept = lines.filter((l) => l.side !== "adds" && l.status === "acted").map((l) => adChangeHeadline(l.exec_class, l.body) ?? "a change in your move");
  if (kept.length && rejected.length) await tell(tenant_id, `move_rejected_partial:${key}`, `You rejected the rest of your move. These cuts already went through and stay: ${kept.join("; ")}.`, "the cuts that went through stay in place");
  return { ok: true, rejected, kept, closed };
}

export type MoveView = {
  key: string;
  still_filing: boolean;
  lines: MoveLineView[];
};
export type MoveLineView = { id: string; decision_class: string; title: string; status: string; side: LegSide; daily_delta_usd: number | null; dispatch_error: string | null; waits_on_cuts: boolean; blocked: { code: string; at: string } | null; suggested: boolean };

function lineView(l: MoveLine): MoveLineView {
  const after = moveAfterOf(l.body);
  return {
    id: l.id,
    decision_class: l.exec_class,
    title: adChangeHeadline(l.exec_class, l.body) ?? "A change in your move",
    status: l.status,
    side: l.side,
    daily_delta_usd: l.daily_delta === null ? null : round2(l.daily_delta),
    dispatch_error: l.dispatch_error ? l.dispatch_error.slice(0, 300) : null,
    waits_on_cuts: !!after && l.status === "proposed",
    blocked: after?.blocked ?? null,
    suggested: l.side !== "adds" && l.status === "proposed" && typeof obj(l.body)[FOUND_FOR_RAISE] === "string",
  };
}

export async function moveView(tenant_id: string, id: string, body: unknown): Promise<MoveView | null> {
  const key = anchorKey(id, body);
  if (!key) return null;
  const { adBudgetChoiceEnabled } = await import("@/services/decisions/ad-budget-choice-flag");
  if (!(await adBudgetChoiceEnabled())) return null;
  const lines = await readMoveLines(tenant_id, key);
  if (lines.length < 2 && !moveAfterOf(body)) return null;
  if (await onBothRails(tenant_id, key)) return null;
  let still_filing = true;
  try {
    const self = lines.find((l) => l.id === id);
    still_filing = (await filingState(tenant_id, key, lines, { id, agent_run_id: self?.agent_run_id ?? null })) !== "quiet";
  } catch (e) {
    console.warn(`[move-card] filing state of ${key} unreadable: ${(e as Error).message}`);
  }
  const order = (l: MoveLine) => (l.side === "adds" ? 1 : 0);
  return {
    key,
    still_filing,
    lines: [...lines].sort((x, y) => order(x) - order(y)).map(lineView),
  };
}

export async function moveFit(tenant_id: string, anchor_id: string, ticked: readonly string[], new_cuts?: readonly NewCut[]): Promise<{ ok: true; net_daily_usd: number; budget_choice: unknown } | { ok: false; code: MoveCode; line_id?: string; candidates?: FounderCutPick[] }> {
  try {
    const anchor = await readDecision(tenant_id, anchor_id);
    if (anchor && new_cuts?.length) {
      if (anchor.status !== "proposed" || legSide(anchor.decision_class, anchor.body) !== "adds") return { ok: false, code: "not_open", line_id: anchor.id };
      const { findMoneyFor, picksMatch } = await import("./founder-cut-candidates");
      const fm = await findMoneyFor(tenant_id, { id: anchor.id, decision_class: anchor.decision_class, body: anchor.body }, { cached: true });
      if (fm.kind === "unreadable") return { ok: true, net_daily_usd: 0, budget_choice: fm.budget_choice };
      const picks = picksMatch(new_cuts, fm.candidates);
      if (!picks) return { ok: false, code: "candidates_changed", candidates: fm.candidates };
      const freed = picks.reduce((s, p) => s + p.frees_daily_usd, 0);
      const plan = planMove(await readMoveLines(tenant_id, anchorKey(anchor.id, anchor.body) ?? `${RAISE_GROUP}${anchor.id}`), ticked);
      if (!plan.ok && plan.code !== "nothing_ticked") return { ok: false, code: plan.code, ...(plan.line ? { line_id: plan.line } : {}) };
      const delta = plan.ok ? plan.net_daily_usd : 0;
      return { ok: true, net_daily_usd: round2(delta - freed), budget_choice: delta > 0 ? await counterCutFit(tenant_id, delta, freed) : { kind: "fits" } };
    }
    const key = anchor ? anchorKey(anchor.id, anchor.body) : null;
    if (!anchor || !key) return { ok: false, code: "not_in_move" };
    const plan = planMove(await readMoveLines(tenant_id, key), ticked);
    if (!plan.ok) return { ok: false, code: plan.code, ...(plan.line ? { line_id: plan.line } : {}) };
    return { ok: true, net_daily_usd: plan.net_daily_usd, budget_choice: plan.net_daily_usd > 0 ? await netFit(tenant_id, plan.net_daily_usd) : { kind: "fits" } };
  } catch (e) {
    console.warn(`[move-card] move fit of ${anchor_id} unreadable: ${(e as Error).message}`);
    const { budgetChoiceView } = await import("@/services/approvals/budget-choice");
    return { ok: true, net_daily_usd: 0, budget_choice: budgetChoiceView({ kind: "unreadable", why: "read" }) };
  }
}

export type FindMoneyView = { kind: "candidates" | "none" | "unreadable"; why: string | null; candidates: FounderCutPick[]; budget_choice: unknown; move: MoveView };

export async function findMoneyView(tenant_id: string, id: string): Promise<FindMoneyView | null> {
  const raise = await readDecision(tenant_id, id);
  if (!raise || raise.status !== "proposed" || legSide(raise.decision_class, raise.body) !== "adds") return null;
  const key = anchorKey(raise.id, raise.body) ?? `${RAISE_GROUP}${raise.id}`;
  const lines = await readMoveLines(tenant_id, key);
  const self = lines.find((l) => l.id === raise.id);
  if (!self) return null;
  const { findMoneyFor } = await import("./founder-cut-candidates");
  const fm = await findMoneyFor(tenant_id, { id: raise.id, decision_class: raise.decision_class, body: raise.body });
  return { kind: fm.kind, why: fm.kind === "candidates" ? null : fm.why, candidates: fm.candidates, budget_choice: fm.budget_choice, move: { key, still_filing: false, lines: [lineView(self)] } };
}
