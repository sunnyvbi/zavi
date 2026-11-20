
import { createHash } from "node:crypto";
import { matchRunCards, type CardTarget, type PoolCard } from "@/services/channels/card-matcher";
import { execCardTarget, execLayer1Keys, targetKeyOf } from "@/services/channels/exec-card-identity";
import { logEvent } from "@/services/logging/logEvent";
import { asTenantId, opsRpc, tenantClient, tenantRpc } from "@/services/tenant-client";
import { listRecent } from "./runs";

export const CARD_CHAIN_KEY = "channel-card-chain";
export const CHANNEL_PAGE = 200;
export const CARDS_PER_CHANNEL = 20_000;
const READ_PAGE = 1000;
const STAMP_BATCH = 500;
const MAX_CONSECUTIVE_ERRORS = 20;
const MAX_ERRORS_KEPT = 50;
const SAMPLE_SIZE = 20;

export type OpenChannel = { tenant_id: string; channel_slug: string; open_count: number; keyless_count: number };

export type OpenCardRow = {
  id: string;
  run_id: string;
  status: string;
  action_type: string;
  title: string;
  title_key: string;
  exec_class: string | null;
  exec_payload: Record<string, unknown> | null;
  exec_status: string | null;
  exec_result: Record<string, unknown> | null;
  edited_body: unknown;
  steps_done: unknown;
  snoozed_until: string | null;
  target_key: string | null;
  step_target: unknown;
  summary: string | null;
  proposed_at: string;
};

export type ChainResult = { ok: boolean; code?: string; replayed?: boolean; chained?: boolean };

export type ChainDeps = {
  listChannels: (after: { tenant: string; channel: string } | null, limit: number) => Promise<OpenChannel[]>;
  loadOpen: (tenantId: string, channel: string) => Promise<OpenCardRow[]>;
  stamp: (tenantId: string, pairs: Array<{ id: string; target_key: string }>) => Promise<number>;
  chain: (tenantId: string, oldId: string, newId: string) => Promise<ChainResult>;
  match: typeof matchRunCards;
  progress: (p: ChainProgress) => Promise<void>;
  log: typeof logEvent;
  now: () => number;
};

export type ChainProgress = {
  cursor: { tenant: string; channel: string } | null;
  complete: boolean;
  channels: number;
  keys_stamped: number;
  chained: number;
  unlinked: number;
  refused: number;
  truncated: number;
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  failed_count: number;
  errors: Array<{ at: string; code: string }>;
};

export type Pair = { old_id: string; new_id: string; layer: 1 | 2 };

const asTarget = (v: unknown): CardTarget | null => {
  const t = v as { kind?: unknown; ref?: unknown } | null;
  return t && typeof t.kind === "string" && typeof t.ref === "string" && t.ref.trim() ? { kind: t.kind, ref: t.ref } : null;
};

export function derivedTargetKey(r: OpenCardRow): string | null {
  if (r.exec_class) return targetKeyOf(execCardTarget(r.exec_class, r.exec_payload ?? {}));
  return targetKeyOf(asTarget(r.step_target));
}

export function keyOf(r: OpenCardRow): string | null {
  return r.target_key ?? derivedTargetKey(r);
}

export function isUntouched(r: OpenCardRow, nowMs: number): boolean {
  if (r.status !== "pending" && r.status !== "snoozed") return false;
  if (r.status === "snoozed" && r.snoozed_until && Date.parse(r.snoozed_until) > nowMs) return false;
  const res = (r.exec_result ?? {}) as Record<string, unknown>;
  if (r.exec_status !== null) {
    if (r.exec_status !== "failed") return false;
    if (["exec_partial", "exec_outcome_unknown"].includes(String(res.code ?? ""))) return false;
    if ("interrupted" in res || "lease_expired" in res) return false;
  }
  if (res.bucket === "partial_risk") return false;
  if (r.edited_body !== null && r.edited_body !== undefined) return false;
  if (Array.isArray(r.steps_done) && r.steps_done.length > 0) return false;
  return true;
}

const newer = (a: OpenCardRow, b: OpenCardRow) => (a.proposed_at === b.proposed_at ? a.id > b.id : Date.parse(a.proposed_at) > Date.parse(b.proposed_at));

export function layer1Pairs(rows: readonly OpenCardRow[], nowMs: number): Pair[] {
  const groups = new Map<string, OpenCardRow[]>();
  const add = (k: string, r: OpenCardRow) => groups.set(k, [...(groups.get(k) ?? []), r]);
  for (const r of rows) {
    if (r.exec_class) {
      for (const k of execLayer1Keys(r.exec_class, r.action_type, r.exec_payload ?? {})) add(`exec|${k}`, r);
    } else {
      const tk = keyOf(r);
      if (tk) add(`prose|${tk}|${r.action_type}|${r.title_key}`, r);
    }
  }
  const next = new Map<string, OpenCardRow>();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const age = (a: OpenCardRow, b: OpenCardRow) => (newer(a, b) ? 1 : newer(b, a) ? -1 : 0);
  for (const [k, g] of groups) {
    if (g.length < 2) continue;
    const sorted = [...g].sort(age);
    sorted.forEach((r, i) => {
      if (i === sorted.length - 1 || !isUntouched(r, nowMs)) return;
      const later = sorted.slice(i + 1).find((w) => !(k.startsWith("prose|") && w.run_id === r.run_id));
      if (!later) return;
      const cur = next.get(r.id);
      if (!cur || newer(cur, later)) next.set(r.id, later);
    });
  }
  return [...next.entries()]
    .map(([old_id, w]) => ({ old_id, new_id: w.id, layer: 1 as const }))
    .sort((a, b) => age(byId.get(a.new_id)!, byId.get(b.new_id)!));
}

export function layer2Groups(rows: readonly OpenCardRow[], paired: ReadonlySet<string>, nowMs: number): Array<{ newest: OpenCardRow; older: OpenCardRow[] }> {
  const byKey = new Map<string, OpenCardRow[]>();
  for (const r of rows) {
    if (paired.has(r.id)) continue;
    const k = keyOf(r);
    if (!k) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const out: Array<{ newest: OpenCardRow; older: OpenCardRow[] }> = [];
  for (const g of byKey.values()) {
    if (g.length < 2) continue;
    const newest = g.reduce((w, r) => (newer(r, w) ? r : w));
    const older = g.filter((r) => r.id !== newest.id && isUntouched(r, nowMs));
    if (older.length > 0) out.push({ newest, older });
  }
  return out;
}

const poolCard = (r: OpenCardRow, channel: string): PoolCard => ({
  id: r.id,
  channel,
  status: "open",
  title: r.title,
  summary: (r.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
  action_type: r.action_type,
  target: asTarget(r.step_target) ?? (r.exec_class ? execCardTarget(r.exec_class, r.exec_payload ?? {}) : null),
});

const blank = (cursor: ChainProgress["cursor"]): ChainProgress => ({
  cursor, complete: false, channels: 0, keys_stamped: 0, chained: 0, unlinked: 0, refused: 0, truncated: 0,
  model_calls: 0, input_tokens: 0, output_tokens: 0, failed_count: 0, errors: [],
});

class BreakerTripped extends Error {}

export async function runCardChain(
  start: { cursor: ChainProgress["cursor"]; useMatcher: boolean; maxChannels: number; truncated?: number },
  deps: ChainDeps,
): Promise<ChainProgress> {
  const p = blank(start.cursor);
  p.truncated = start.truncated ?? 0;
  let consecutive = 0;
  const fail = (at: string, e: unknown) => {
    p.failed_count++;
    consecutive++;
    p.errors = [...p.errors, { at, code: String((e as Error)?.message ?? e).slice(0, 120) }].slice(-MAX_ERRORS_KEPT);
    if (consecutive >= MAX_CONSECUTIVE_ERRORS) {
      throw new BreakerTripped(`stopped after ${MAX_CONSECUTIVE_ERRORS} errors in a row (last: ${p.errors.at(-1)?.code ?? "unknown"}); resume continues from the cursor`);
    }
  };
  const succeeded = () => {
    consecutive = 0;
  };
  for (;;) {
    const page = await deps.listChannels(p.cursor, CHANNEL_PAGE);
    if (page.length === 0) {
      p.complete = p.truncated === 0;
      break;
    }
    for (const ch of page) {
      if (p.channels >= start.maxChannels) {
        await deps.progress({ ...p });
        return p;
      }
      const at = `${ch.tenant_id}:${ch.channel_slug}`;
      const before = { keys: p.keys_stamped, chained: p.chained, refused: p.refused, calls: p.model_calls };
      try {
        const failedBefore = p.failed_count;
        await chainChannel(ch, start.useMatcher, deps, p, fail, succeeded);
        if (p.failed_count === failedBefore) succeeded();
      } catch (e) {
        try {
          if (e instanceof BreakerTripped) throw e;
          fail(at, e);
        } catch (tripped) {
          await deps.progress({ ...p });
          throw tripped;
        }
      }
      p.channels++;
      p.cursor = { tenant: ch.tenant_id, channel: ch.channel_slug };
      await deps.progress({ ...p });
      void deps.log({
        level: "info",
        source: "admin_scripts.card_chain",
        code: "card_chain_channel",
        message: `${at}: keys ${p.keys_stamped - before.keys}, chained ${p.chained - before.chained}, refused ${p.refused - before.refused}, model calls ${p.model_calls - before.calls}`,
        tenant_id: ch.tenant_id,
      });
    }
    if (page.length < CHANNEL_PAGE) {
      p.complete = p.truncated === 0;
      break;
    }
  }
  await deps.progress({ ...p });
  return p;
}

async function chainChannel(
  ch: OpenChannel,
  useMatcher: boolean,
  deps: ChainDeps,
  p: ChainProgress,
  fail: (at: string, e: unknown) => void,
  succeeded: () => void,
): Promise<void> {
  const rows = await deps.loadOpen(ch.tenant_id, ch.channel_slug);
  const nowMs = deps.now();
  if (rows.length < ch.open_count) {
    p.truncated++;
    fail(`${ch.tenant_id}:${ch.channel_slug}`, new Error(`truncated: read ${rows.length} of ${ch.open_count} open cards`));
  }
  const stamps = rows.filter((r) => r.target_key === null).map((r) => ({ id: r.id, target_key: derivedTargetKey(r) })).filter((s): s is { id: string; target_key: string } => s.target_key !== null);
  for (let i = 0; i < stamps.length; i += STAMP_BATCH) {
    p.keys_stamped += await deps.stamp(ch.tenant_id, stamps.slice(i, i + STAMP_BATCH));
  }
  const keyed = rows.map((r) => (r.target_key === null ? { ...r, target_key: derivedTargetKey(r) } : r));
  const pairs = layer1Pairs(keyed, nowMs);
  if (useMatcher) {
    const paired = new Set(pairs.map((x) => x.old_id));
    for (const g of layer2Groups(keyed, paired, nowMs)) {
      p.model_calls++;
      const fresh = [{ ref: "n0", title: g.newest.title, summary: (g.newest.summary ?? "").slice(0, 300), action_type: g.newest.action_type, target: poolCard(g.newest, ch.channel_slug).target }];
      const m = await deps.match(ch.channel_slug, fresh, g.older.map((r) => poolCard(r, ch.channel_slug)));
      if (!m) continue;
      p.input_tokens += m.input_tokens;
      p.output_tokens += m.output_tokens;
      const v = m.verdicts[0];
      if (v?.decision === "same_open" && v.match_id) pairs.push({ old_id: v.match_id, new_id: g.newest.id, layer: 2 });
    }
  }
  for (const pair of pairs) {
    try {
      const out = await deps.chain(ch.tenant_id, pair.old_id, pair.new_id);
      succeeded();
      if (out.ok) {
        if (out.replayed) continue;
        if (out.chained === true) p.chained++;
        else p.unlinked++;
      } else {
        p.refused++;
      }
    } catch (e) {
      fail(`${ch.tenant_id}:${pair.old_id}`, e);
    }
  }
}

export type ChainPreview = {
  channels: number;
  keys_missing: number;
  pairs: number;
  model_calls_estimate: number;
  truncated: number;
  sample: Array<{ tenant_id: string; channel_slug: string; old_id: string; new_id: string }>;
  preview_token: string;
};

export async function previewCardChain(
  opts: { useMatcher: boolean },
  deps: Pick<ChainDeps, "listChannels" | "loadOpen" | "now">,
): Promise<ChainPreview> {
  const out: ChainPreview = { channels: 0, keys_missing: 0, pairs: 0, model_calls_estimate: 0, truncated: 0, sample: [], preview_token: "" };
  const touched: string[] = [];
  let cursor: ChainProgress["cursor"] = null;
  for (;;) {
    const page = await deps.listChannels(cursor, CHANNEL_PAGE);
    for (const ch of page) {
      cursor = { tenant: ch.tenant_id, channel: ch.channel_slug };
      out.channels++;
      const rows = await deps.loadOpen(ch.tenant_id, ch.channel_slug);
      const nowMs = deps.now();
      if (rows.length < ch.open_count) out.truncated++;
      for (const r of rows) {
        if (r.target_key !== null) continue;
        const k = derivedTargetKey(r);
        if (k) {
          out.keys_missing++;
          touched.push(`k:${r.id}:${k}`);
        }
      }
      const keyed = rows.map((r) => (r.target_key === null ? { ...r, target_key: derivedTargetKey(r) } : r));
      const pairs = layer1Pairs(keyed, nowMs);
      out.pairs += pairs.length;
      for (const x of pairs) {
        touched.push(`p:${x.old_id}:${x.new_id}`);
        if (out.sample.length < SAMPLE_SIZE) out.sample.push({ tenant_id: ch.tenant_id, channel_slug: ch.channel_slug, old_id: x.old_id, new_id: x.new_id });
      }
      if (opts.useMatcher) {
        for (const g of layer2Groups(keyed, new Set(pairs.map((x) => x.old_id)), nowMs)) {
          out.model_calls_estimate++;
          touched.push(`m:${g.newest.id}:${g.older.map((r) => r.id).sort().join(",")}`);
        }
      }
    }
    if (page.length < CHANNEL_PAGE) break;
  }
  out.preview_token = createHash("sha256").update(`${opts.useMatcher}\n${touched.join("\n")}`).digest("hex").slice(0, 32);
  return out;
}

export function chainConfirmPhrase(p: ChainPreview, useMatcher: boolean): string {
  return useMatcher ? `CHAIN ${p.pairs} JUDGE ${p.model_calls_estimate}` : `CHAIN ${p.pairs}`;
}

export async function listOpenChannels(after: ChainProgress["cursor"], limit: number): Promise<OpenChannel[]> {
  const { data, error } = await opsRpc("list_open_card_channels", {
    p_after_tenant: after?.tenant ?? null,
    p_after_channel: after?.channel ?? null,
    p_limit: limit,
  });
  if (error) throw new Error(`list_open_card_channels failed: ${error.message}`);
  return (data ?? []) as OpenChannel[];
}

const OPEN_COLS =
  "id, run_id, status, action_type, title, title_key, exec_class, exec_payload, exec_status, exec_result, edited_body, steps_done, snoozed_until, target_key, step_target:body->step->target, summary:body->step->>body, proposed_at";

export async function loadOpenCards(tenantId: string, channel: string): Promise<OpenCardRow[]> {
  const out: OpenCardRow[] = [];
  while (out.length < CARDS_PER_CHANNEL) {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("channel_actions")
      .select(OPEN_COLS)
      .eq("channel_slug", channel)
      .in("status", ["pending", "snoozed"])
      .order("proposed_at", { ascending: false })
      .order("id", { ascending: false })
      .range(out.length, Math.min(out.length + READ_PAGE, CARDS_PER_CHANNEL) - 1);
    if (error) throw new Error(`open cards read failed: ${error.message}`);
    const page = (data ?? []) as unknown as OpenCardRow[];
    out.push(...page);
    if (page.length < READ_PAGE) break;
  }
  return out;
}

export async function stampTargetKeys(tenantId: string, pairs: Array<{ id: string; target_key: string }>): Promise<number> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), "stamp_channel_action_target_keys", { p_pairs: pairs });
  if (error) throw new Error(`stamp_channel_action_target_keys failed: ${error.message}`);
  return Number(data ?? 0);
}

export async function chainRepeat(tenantId: string, oldId: string, newId: string): Promise<ChainResult> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), "chain_channel_action_repeat", { p_old_id: oldId, p_new_id: newId });
  if (error) throw new Error(error.message);
  return (data ?? { ok: false, code: "no_answer" }) as ChainResult;
}

export const DEFAULT_CHAIN_DEPS: Omit<ChainDeps, "progress"> = {
  listChannels: listOpenChannels,
  loadOpen: loadOpenCards,
  stamp: stampTargetKeys,
  chain: chainRepeat,
  match: matchRunCards,
  log: logEvent,
  now: () => Date.now(),
};

export async function chainResumeState(): Promise<{ cursor: ChainProgress["cursor"]; truncated: number }> {
  const none = { cursor: null, truncated: 0 };
  const [latest] = await listRecent(CARD_CHAIN_KEY, 1);
  if (!latest) return none;
  const prog = (latest.progress ?? {}) as Partial<ChainProgress>;
  if (latest.status !== "failed" && prog.complete !== false) return none;
  const c = prog.cursor;
  const cursor = c && typeof c.tenant === "string" && /^[0-9a-f-]{36}$/i.test(c.tenant) && typeof c.channel === "string" ? { tenant: c.tenant, channel: c.channel } : null;
  return { cursor, truncated: cursor && typeof prog.truncated === "number" ? prog.truncated : 0 };
}

export async function chainResumeCursor(): Promise<ChainProgress["cursor"]> {
  return (await chainResumeState()).cursor;
}
