
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { writeAutopilotGoal } from "./goal-write";
import type { QuestionAsk } from "./cgo-questions";
import type { GoalRow } from "./goal-owner";
import {
  confirmedRule,
  countedSource,
  defaultCountDeps,
  failureWords,
  parseCountRule,
  ruleFromProposal,
  ruleKey,
  runCountRule,
  type CountDeps,
  type CountRule,
  type ProposedCountRule,
} from "./goal-count-rule";

export const STALE_ASK_AFTER_MS = 36 * 60 * 60 * 1000;

function fmt(n: number): string {
  const [whole, frac] = String(Number(n)).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

const bare = (t: string) => t.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");

export function countAsk(objective: string, definition: string, value: number): string {
  const def = bare(definition);
  const shown = fmt(value);
  const num = new RegExp(`(?<![\\d.,])${shown.replace(/[.,]/g, (c) => `\\${c}`)}(?![\\d]|[.,]\\d)`);
  const said = /[.,]/.test(shown) && def.split(/(?<=[.!?])\s+/).some((sentence) => /\btoday\b/i.test(sentence) && num.test(sentence));
  const today = said ? "" : ` Today that is ${fmt(value)}.`;
  return `I'll count "${bare(objective)}" as ${def}.${today} Use this?`;
}

export function recountAsk(objective: string, definition: string, value: number): string {
  return `The data behind "${bare(objective)}" changed, so I stopped counting it. Counted the same way (${bare(definition)}), today it is ${fmt(value)}. Keep counting it this way?`;
}

export function expiredNumberAsk(objective: string, value: number, ageDays: number | null, opts: { hasDataSource?: boolean } = {}): string {
  const when = ageDays == null ? "and I can't tell when it was entered" : `which you entered ${ageDays} day${ageDays === 1 ? "" : "s"} ago`;
  return `"${objective}" shows ${fmt(value)}, ${when}. What is it today? ${updateWays(opts.hasDataSource)}`;
}

function updateWays(hasDataSource: boolean | undefined): string {
  return hasDataSource === false ? "Update it on the goal." : "Update it on the goal, or tell me how to count it from your data.";
}

type GoalLike = Pick<GoalRow, "id" | "objective" | "current_value" | "current_value_at" | "measurement_mode"> & { count_rule?: unknown };

export async function countRuleAsks(args: {
  tenant_id: string;
  proposals: ProposedCountRule[];
  goals: GoalLike[];
  today: string;
  now: Date;
  openTopics: ReadonlySet<string>;
  trusted: (g: GoalLike) => boolean;
  ageDays: (g: GoalLike) => number | null;
  deps?: CountDeps;
  needsPaceNumber?: (g: GoalLike) => boolean;
}): Promise<{ asks: QuestionAsk[]; refused: string[] }> {
  const deps = args.deps ?? defaultCountDeps;
  const asks: QuestionAsk[] = [];
  const refused: string[] = [];
  const byId = new Map(args.goals.map((g) => [g.id, g]));
  const asked = new Set<string>();
  let source: Promise<boolean | undefined> | null = null;
  const hasDataSource = () =>
    (source ??= deps
      .catalog(args.tenant_id)
      .then((c) => !!c && !c.discovery_error && (c.catalog?.tables ?? []).length > 0)
      .catch(() => undefined));
  const hasOpen = (goalId: string) =>
    asked.has(goalId) || [...args.openTopics].some((t) => t.startsWith(`count:${goalId}:`) || t === `count-stale:${goalId}` || t === `number:${goalId}`);

  for (const p of args.proposals.slice(0, 3)) {
    const g = byId.get(p.goal_id);
    if (!g) continue;
    if (confirmedRule(g.count_rule) && !parseCountRule(g.count_rule)?.stale_reason) {
      refused.push(`Count rule for "${g.objective}": it already has one.`);
      continue;
    }
    if (hasOpen(g.id)) continue;
    const rule = ruleFromProposal(p);
    if (!rule) {
      refused.push(`Count rule for "${g.objective}": a ${p.dialect} rule needs ${p.dialect === "sql" ? "a query" : "a collection and a pipeline"}.`);
      continue;
    }
    const dry = await runCountRule(args.tenant_id, rule, { checkHash: false }, deps);
    if (!dry.ok) {
      refused.push(`Count rule for "${g.objective}": dry run refused (${dry.reason}).`);
      continue;
    }
    const stored: CountRule & { goal_id: string } = { ...rule, schema_hash: dry.schema_hash, goal_id: g.id };
    asks.push({
      topic_key: `count:${g.id}:${ruleKey(rule, dry.schema_hash)}`,
      ask: countAsk(g.objective, rule.definition, dry.value),
      default_action: null,
      count_rule: stored,
    });
    asked.add(g.id);
  }

  for (const g of args.goals) {
    if (hasOpen(g.id)) continue;
    const rule = confirmedRule(g.count_rule);
    if (rule?.stale_reason) {
      if (rule.stale_reason === "schema_changed") {
        const dry = await runCountRule(args.tenant_id, rule, { checkHash: false }, deps);
        if (dry.ok) {
          const { confirmed_at: _c, confirmed_by: _b, stale_reason: _r, stale_at: _a, ...base } = rule;
          asks.push({
            required: true,
            topic_key: `count:${g.id}:${ruleKey(rule, dry.schema_hash)}`,
            ask: recountAsk(g.objective, rule.definition, dry.value),
            default_action: null,
            count_rule: { ...base, schema_hash: dry.schema_hash, goal_id: g.id },
          });
          asked.add(g.id);
          continue;
        }
      }
      const since = Date.parse(rule.stale_at ?? "");
      if (rule.stale_reason === "schema_changed" || (Number.isFinite(since) && args.now.getTime() - since >= STALE_ASK_AFTER_MS)) {
        asks.push({
          required: true,
          topic_key: `count-stale:${g.id}`,
          ask: `I couldn't count "${g.objective}" as ${rule.definition}: ${failureWords(rule.stale_reason)}. How should I count it now?`,
          default_action: null,
        });
        asked.add(g.id);
      }
      continue;
    }
    if (g.current_value == null) continue;
    const staleTyped = g.measurement_mode !== "auto" && (args.needsPaceNumber?.(g) === true || !args.trusted(g));
    if (!rule && staleTyped) {
      const o = { hasDataSource: await hasDataSource() };
      asks.push({
        topic_key: `number:${g.id}`,
        ask: expiredNumberAsk(g.objective, Number(g.current_value), args.ageDays(g), o),
        default_action: null,
      });
      asked.add(g.id);
    }
  }
  return { asks, refused };
}

export async function applyCountRuleConfirmations(args: {
  tenant_id: string;
  run_id: string;
  question_ids: string[];
  via: string;
  goals: GoalLike[];
  now: Date;
  deps?: CountDeps;
}): Promise<{ changed: string[]; refused: string[] }> {
  const out = { changed: [] as string[], refused: [] as string[] };
  if (args.question_ids.length === 0) return out;
  const db = tenantClient(asTenantId(args.tenant_id));
  const byId = new Map(args.goals.map((g) => [g.id, g]));
  for (const qid of [...new Set(args.question_ids)].slice(0, 5)) {
    const { data: q, error } = await db
      .from("cgo_questions")
      .select("id, topic_key, count_rule, status, resolved_run_id")
      .eq("id", qid)
      .eq("tenant_id", args.tenant_id)
      .maybeSingle<{ id: string; topic_key: string; count_rule: unknown; status: string; resolved_run_id: string | null }>();
    if (error || !q) continue;
    if (!q.topic_key.startsWith("count:") || q.status !== "answered" || q.resolved_run_id !== args.run_id) {
      out.refused.push(`Count confirmation ${qid}: not a count question this reply answered.`);
      continue;
    }
    const raw = (q.count_rule ?? null) as (Record<string, unknown> & { goal_id?: unknown }) | null;
    const goalId = typeof raw?.goal_id === "string" ? raw.goal_id : null;
    const { goal_id: _g, ...ruleOnly } = raw ?? {};
    const rule = parseCountRule(ruleOnly);
    const g = goalId ? byId.get(goalId) : undefined;
    if (!rule || !g || !q.topic_key.startsWith(`count:${g.id}:`)) {
      out.refused.push(`Count confirmation ${qid}: its goal is not active or the rule is unreadable.`);
      continue;
    }
    const run = await runCountRule(args.tenant_id, rule, { checkHash: true }, args.deps ?? defaultCountDeps);
    if (!run.ok) {
      out.refused.push(`Count rule for "${g.objective}": confirmed, but today's count failed (${run.reason}), so it was not saved.`);
      continue;
    }
    const saved: CountRule = {
      ...rule,
      confirmed_at: args.now.toISOString(),
      confirmed_by: `founder (${args.via} reply)`.slice(0, 60),
      stale_reason: null,
      stale_at: null,
    };
    const w = await writeAutopilotGoal(args.tenant_id, {
      op: "update",
      goal_id: g.id,
      values: { count_rule: saved },
      expect: { status: "active" },
      actor: { source: "cgo", run_id: args.run_id, why: `The founder confirmed counting it as ${rule.definition}`.slice(0, 1000) },
    });
    if (w.status !== "written") {
      out.refused.push(`Count rule for "${g.objective}": saving it failed.`);
      continue;
    }
    if (await writeCountedNumber(args.tenant_id, g.id, run.value, rule.definition, args.now)) {
      out.changed.push(`Counting "${g.objective}" every day as ${rule.definition}. Today it is ${fmt(run.value)}.`);
    } else {
      out.changed.push(`Counting "${g.objective}" every day as ${rule.definition}, starting with tomorrow's count.`);
    }
  }
  return out;
}

export async function writeCountedNumber(tenant_id: string, goal_id: string, value: number, definition: string, now: Date): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("autopilot_goals")
    .update({ current_value: value, current_value_at: now.toISOString(), current_value_source: countedSource(definition), updated_at: now.toISOString() })
    .eq("id", goal_id)
    .eq("tenant_id", tenant_id)
    .eq("status", "active")
    .select("id");
  if (error) console.warn(`[goal-count] writing the count failed for goal ${goal_id}: ${error.message}`);
  return !error && ((data ?? []) as unknown[]).length > 0;
}

export type CountSourceView = {
  dialect: string;
  tables: string[];
  key_tables: string;
};

const NAMES_BUDGET = 6000;
const KEY_TABLES_BUDGET = 4000;

export async function countSourceView(tenant_id: string, needs: boolean): Promise<CountSourceView | undefined> {
  if (!needs) return undefined;
  try {
    const { getCatalog, renderCatalogDigest } = await import("@/services/tools/operator-db/catalog");
    const c = await getCatalog(tenant_id);
    if (!c || c.discovery_error || !(c.catalog.tables ?? []).length) return undefined;
    const tables: string[] = [];
    let used = 0;
    for (const t of c.catalog.tables) {
      used += t.name.length + 3;
      if (used > NAMES_BUDGET) break;
      tables.push(t.name);
    }
    const hinted = [c.hints.users?.table, c.hints.listings?.table, c.hints.bookings?.table, c.hints.transactions?.table].filter(
      (x): x is string => typeof x === "string" && x.length > 0,
    );
    const digest = hinted.length ? renderCatalogDigest(c.catalog, { only: hinted }) : "";
    return { dialect: c.dialect, tables, key_tables: digest.slice(0, KEY_TABLES_BUDGET) };
  } catch {
    return undefined;
  }
}

export function goalsNeedCounting(goals: GoalLike[], trusted: (g: GoalLike) => boolean): boolean {
  return goals.some((g) => !confirmedRule(g.count_rule) && !(g.measurement_mode === "auto" && trusted(g)));
}
