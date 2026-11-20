
import { callModel } from "@/services/llm/call-model";
import { DEFAULT_PROVIDER, MODELS } from "@/services/llm/models";
import { logEvent } from "@/services/logging/logEvent";
import { tenantClient, type TenantId } from "@/services/tenant-client";

export type CardTarget = { kind: string; ref: string };

export type FreshCard = {
  ref: string;
  title: string;
  summary: string;
  action_type?: string | null;
  target?: CardTarget | null;
};

export type PoolCard = {
  id: string;
  channel: string;
  status: "open" | "acted" | "rejected";
  title: string;
  summary: string;
  action_type?: string | null;
  target?: CardTarget | null;
};

export type MatchDecision = "new" | "same_open" | "same_new" | "already_done" | "already_rejected";

export type MatchVerdict = {
  ref: string;
  decision: MatchDecision;
  match_id: string | null;
  changed: boolean;
  reason: string;
};

export const POOL_MAX = 80;
export const POOL_DAYS = 90;
const SUMMARY_CHARS = 300;

export function normalizeRef(t: CardTarget): string {
  let r = String(t.ref ?? "").trim().toLowerCase();
  const url = r.match(/^https?:\/\/[^/]+(\/[^?#]*)?/);
  if (url) r = url[1] ?? "/";
  r = r.replace(/^@/, "").replace(/[^a-z0-9/$%_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (r.length > 1) r = r.replace(/\/+$/, "");
  return `${t.kind}:${r}`;
}

function asTarget(v: unknown): CardTarget | null {
  const t = v as { kind?: unknown; ref?: unknown } | null;
  return t && typeof t.kind === "string" && typeof t.ref === "string" && t.ref.trim() ? { kind: t.kind, ref: t.ref } : null;
}

export function targetFromKey(key: unknown): CardTarget | null {
  if (typeof key !== "string") return null;
  const i = key.indexOf(":");
  if (i <= 0 || i === key.length - 1) return null;
  return { kind: key.slice(0, i), ref: key.slice(i + 1) };
}

export function mayBeSameWork(a: { target?: CardTarget | null }, b: { target?: CardTarget | null }): boolean {
  if (a.target?.kind === "queue" || b.target?.kind === "queue") return false;
  if (a.target && b.target) return normalizeRef(a.target) === normalizeRef(b.target);
  return true;
}

export function matcherEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHANNEL_CARD_MATCHER !== "0";
}

export function summarize(stepBody: unknown, deliverableLabel?: unknown): string {
  const body = typeof stepBody === "string" ? stepBody : "";
  const label = typeof deliverableLabel === "string" && deliverableLabel.trim() ? ` [deliverable: ${deliverableLabel.trim()}]` : "";
  return (body.replace(/\s+/g, " ").trim().slice(0, SUMMARY_CHARS) + label).trim();
}

export const SAME_WORK_RULE =
  "Two cards are the SAME work when they target the same thing (page, account, campaign, audience, person, " +
  "asset) AND ask for the same change, so doing one makes the other pointless. Parts of a series (email 1 and " +
  "email 2), the same kind of change on different targets (two different pages, two different creators), and " +
  "different posts on the same topic are NOT the same work. For content (an article, post, video, email), it " +
  "is the same work only when it is the same piece: a new piece with its own headline or angle is new, even on " +
  "a related topic. A step that prepares for " +
  "another card (making its asset, a prerequisite) is NOT the same work as that card, and a broad catch-all " +
  "card (review a queue, clear pending items) does not make a specific card inside it a repeat.";

export function buildMatcherPrompt(channel: string, fresh: readonly FreshCard[], pool: readonly PoolCard[]): {
  system: string;
  user: string;
} {
  const system =
    "You deduplicate the action cards an AI growth tool writes for a founder. " +
    SAME_WORK_RULE +
    " For each NEW card decide exactly one of: " +
    '"new" (no existing card is the same work), ' +
    '"same_open" (the same work as an OPEN card listed below), ' +
    '"same_new" (the same work as an EARLIER new card in this same list; match_id is that card\'s ref), ' +
    '"already_done" (the same work as a card the founder ACTED on), ' +
    '"already_rejected" (the same work as a card the founder REJECTED). ' +
    'For already_done / already_rejected also set "changed": true ONLY when the new card names a concrete new ' +
    "fact that makes the old outcome no longer apply (for example the thing was undone, or the target changed); " +
    "otherwise false. When unsure, answer \"new\". " +
    'Return ONLY a JSON array: [{"ref":"n1","decision":"new|same_open|same_new|already_done|already_rejected",' +
    '"match_id":"<existing card id, or the earlier new card\'s ref for same_new, or null>","changed":false,' +
    '"reason":"<one short sentence>"}].';
  const tag = (c: { action_type?: string | null; target?: CardTarget | null }) =>
    [c.action_type ? `type=${c.action_type}` : "", c.target ? `target=${c.target.kind}:${c.target.ref}` : ""].filter(Boolean).join(" ");
  const poolLines = pool.map(
    (p) => `- id=${p.id} [${p.status.toUpperCase()}${p.channel === channel ? "" : `, channel ${p.channel}`}] ${tag(p)} ${p.title} :: ${p.summary}`,
  );
  const freshLines = fresh.map((f) => `- ref=${f.ref} ${tag(f)} ${f.title} :: ${f.summary}`);
  const user =
    `Channel: ${channel}\n\nEXISTING CARDS:\n${poolLines.join("\n")}\n\nNEW CARDS:\n${freshLines.join("\n")}\n\n` +
    "JSON array only:";
  return { system, user };
}

const STATUS_FOR: Record<Exclude<MatchDecision, "new" | "same_new">, PoolCard["status"]> = {
  same_open: "open",
  already_done: "acted",
  already_rejected: "rejected",
};

export function parseMatchVerdicts(
  text: string,
  channel: string,
  fresh: readonly FreshCard[],
  pool: readonly PoolCard[],
): MatchVerdict[] | null {
  const m = String(text ?? "").match(/\[[\s\S]*\]/);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const byId = new Map(pool.map((p) => [p.id, p]));
  const answered = new Map<string, MatchVerdict>();
  for (const v of raw as Array<Record<string, unknown>>) {
    const ref = typeof v?.ref === "string" ? v.ref : "";
    if (!fresh.some((f) => f.ref === ref) || answered.has(ref)) continue;
    const decision = v.decision as MatchDecision;
    const reason = typeof v.reason === "string" ? v.reason.slice(0, 300) : "";
    const asNew: MatchVerdict = { ref, decision: "new", match_id: null, changed: false, reason };
    if (decision === "same_new") {
      const at = fresh.findIndex((f) => f.ref === ref);
      const first = fresh.findIndex((f) => f.ref === v.match_id);
      answered.set(
        ref,
        first >= 0 && first < at ? { ref, decision, match_id: fresh[first].ref, changed: false, reason } : asNew,
      );
      continue;
    }
    if (decision === "new" || !(decision in STATUS_FOR)) {
      answered.set(ref, asNew);
      continue;
    }
    const target = typeof v.match_id === "string" ? byId.get(v.match_id) : undefined;
    const changedOk = decision === "same_open" || typeof v.changed === "boolean";
    const trusted =
      !!target &&
      changedOk &&
      target.status === STATUS_FOR[decision as Exclude<MatchDecision, "new" | "same_new">] &&
      (decision !== "same_open" || target.channel === channel);
    answered.set(
      ref,
      trusted
        ? { ref, decision, match_id: target!.id, changed: decision !== "same_open" && v.changed === true, reason }
        : asNew,
    );
  }
  const out = fresh.map((f) => answered.get(f.ref) ?? { ref: f.ref, decision: "new" as const, match_id: null, changed: false, reason: "" });
  const byRef = new Map(out.map((v) => [v.ref, v]));
  for (const v of out) {
    if (v.decision !== "same_new") continue;
    const anchor = byRef.get(v.match_id ?? "");
    if (!anchor || isDropped(anchor)) Object.assign(v, { decision: "new", match_id: null });
  }
  return out;
}

export function isDropped(v: MatchVerdict): boolean {
  return (
    v.decision === "same_new" ||
    ((v.decision === "already_done" || v.decision === "already_rejected") && !v.changed)
  );
}

export function isReplace(v: MatchVerdict): boolean {
  return v.decision === "same_open" && v.match_id !== null;
}

export type MatchDeps = { call?: typeof callModel };

export function hasMatchCandidates(fresh: readonly FreshCard[], pool: readonly PoolCard[]): boolean {
  return fresh.some((f, i) => pool.some((p) => mayBeSameWork(f, p)) || fresh.slice(0, i).some((e) => mayBeSameWork(f, e)));
}

export async function matchRunCards(
  channel: string,
  fresh: readonly FreshCard[],
  pool: readonly PoolCard[],
  deps: MatchDeps = {},
): Promise<{ verdicts: MatchVerdict[]; input_tokens: number; output_tokens: number } | null> {
  const poolFor = new Map<string, Set<string>>();
  const runFor = new Map<string, Set<string>>();
  fresh.forEach((f, i) => {
    poolFor.set(f.ref, new Set(pool.filter((p) => mayBeSameWork(f, p)).map((p) => p.id)));
    runFor.set(f.ref, new Set(fresh.slice(0, i).filter((e) => mayBeSameWork(f, e)).map((e) => e.ref)));
  });
  const hasCandidate = (f: FreshCard) => poolFor.get(f.ref)!.size > 0 || runFor.get(f.ref)!.size > 0;
  const asked = fresh.filter((f) => hasCandidate(f) || fresh.some((g) => runFor.get(g.ref)!.has(f.ref)));
  if (!asked.some(hasCandidate)) return null;
  const askedPool = pool.filter((p) => asked.some((f) => poolFor.get(f.ref)!.has(p.id)));
  try {
    const { system, user } = buildMatcherPrompt(channel, asked, askedPool);
    const resp = await (deps.call ?? callModel)({
      provider: DEFAULT_PROVIDER,
      model: MODELS.anthropic.haiku,
      system,
      messages: [{ role: "user", content: user }],
      max_tokens: 1500,
      temperature: 0,
      timeoutMs: 20_000,
      maxAttempts: 2,
    });
    const parsed = parseMatchVerdicts(resp.text, channel, asked, askedPool);
    if (!parsed) {
      matchFailed(channel, "unparseable", Number(resp.usage?.input_tokens ?? 0), Number(resp.usage?.output_tokens ?? 0));
      return null;
    }
    const byRef = new Map(parsed.map((v) => [v.ref, v]));
    const verdicts = fresh.map((f): MatchVerdict => {
      const v = byRef.get(f.ref);
      if (!v || v.decision === "new") return { ref: f.ref, decision: "new", match_id: null, changed: false, reason: v?.reason ?? "" };
      const allowed = v.decision === "same_new" ? runFor.get(f.ref)!.has(v.match_id ?? "") : poolFor.get(f.ref)!.has(v.match_id ?? "");
      return allowed ? v : { ref: f.ref, decision: "new", match_id: null, changed: false, reason: v.reason };
    });
    const out = new Map(verdicts.map((v) => [v.ref, v]));
    for (const v of verdicts) {
      if (v.decision !== "same_new") continue;
      const anchor = out.get(v.match_id ?? "");
      if (!anchor || isDropped(anchor)) Object.assign(v, { decision: "new", match_id: null });
    }
    return {
      verdicts,
      input_tokens: Number(resp.usage?.input_tokens ?? 0),
      output_tokens: Number(resp.usage?.output_tokens ?? 0),
    };
  } catch (e) {
    matchFailed(channel, String((e as Error)?.message ?? e).slice(0, 200), 0, 0);
    return null;
  }
}

function matchFailed(channel: string, why: string, input_tokens: number, output_tokens: number): void {
  void logEvent({
    level: "warn",
    source: "channel_actions.match",
    code: "channel.card_match_failed",
    message: `channel=${channel} matcher failed open: ${why}`,
    meta: { input_tokens, output_tokens },
  }).catch(() => undefined);
}

export type MatchPool = PoolCard[] & { readFailed?: true };

export const TARGET_POOL_MAX = 500;

export async function loadMatchPool(
  tid: TenantId,
  channel: string,
  nowMs: number = Date.now(),
  targetKeys: readonly string[] = [],
): Promise<MatchPool> {
  const failed = (): MatchPool => Object.assign([] as PoolCard[], { readFailed: true as const });
  try {
    const since = new Date(nowMs - POOL_DAYS * 86_400_000).toISOString();
    const cols =
      "id, channel_slug, status, title, action_type, target_key, target:body->step->target, summary:body->step->>body, label:body->step->deliverable->>label";
    const db = tenantClient(tid);
    const keys = [...new Set(targetKeys.filter((k) => typeof k === "string" && k.length > 0))];
    const [openRes, closedRes, targetRes] = await Promise.all([
      db
        .from("channel_actions")
        .select(cols)
        .eq("channel_slug", channel)
        .in("status", ["pending", "snoozed"])
        .order("proposed_at", { ascending: false })
        .limit(POOL_MAX / 2),
      db
        .from("channel_actions")
        .select(cols)
        .in("status", ["acted", "rejected"])
        .gte("proposed_at", since)
        .order("proposed_at", { ascending: false })
        .limit(POOL_MAX / 2),
      keys.length > 0
        ? db
            .from("channel_actions")
            .select(cols)
            .eq("channel_slug", channel)
            .in("status", ["pending", "snoozed"])
            .in("target_key", keys)
            .order("proposed_at", { ascending: false })
            .limit(TARGET_POOL_MAX)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (openRes.error || closedRes.error || targetRes.error) return failed();
    const seen = new Set<string>();
    const rows = [...(openRes.data ?? []), ...(targetRes.data ?? []), ...(closedRes.data ?? [])] as Array<Record<string, unknown>>;
    const out: MatchPool = [];
    for (const r of rows) {
      const id = String(r.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        channel: String(r.channel_slug),
        status: r.status === "acted" ? "acted" : r.status === "rejected" ? "rejected" : "open",
        title: String(r.title ?? ""),
        summary: summarize(r.summary, r.label),
        action_type: typeof r.action_type === "string" ? r.action_type : null,
        target: asTarget(r.target) ?? targetFromKey(r.target_key),
      });
    }
    return out;
  } catch {
    return failed();
  }
}
