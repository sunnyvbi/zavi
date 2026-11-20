
import type { ToolEffect } from "@/services/tools/types";
import { z } from "zod";
import type { McpCallResult, McpTool } from "../types";
import { serviceClient } from "@/services/supabase";
import { CHANNELS } from "@zavi/shared";
import { OPEN_CHANNEL_ACTIONS_VIEW } from "@/services/channels/open-actions-count";
import { resolveChannelAction } from "@/services/channels/card-context";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";
import { scrubQueryForCapture } from "@/services/memory/eval-capture-scrub";
import {
  EXTENDED_LOOKBACK_DAYS,
  isThinCorpus,
  loadResolvedSignatures,
  applyDecayAndSuppression,
  type AdaptiveRunRow,
  type AdaptiveLookbackMeta,
} from "./pm-adaptive-lookback";

const MAX_RESPONSE_BYTES = 200 * 1024;
const OUTPUT_EXCERPT_BYTES = 2 * 1024;
const PARSED_EXCERPT_BYTES = 1 * 1024;
const ERROR_EXCERPT_BYTES = 500;
const DECISION_BODY_EXCERPT_BYTES = 500;
const PEER_CONTENT_CAP = 64 * 1024;
const FEEDBACK_COMMENT_EXCERPT_CHARS = 280;
const FEEDBACK_MAX_COMMENTS = 30;
const SUPPORT_THEME_MAX_ROWS_SCANNED = 800;
const SUPPORT_THEME_MAX_THEMES = 12;
const SUPPORT_THEME_SNIPPET_CHARS = 200;
const SUPPORT_THEME_SNIPPETS_PER_THEME = 2;

const queryRecentRunsInput = z.object({
  days: z.number().int().min(1).max(90).default(14),
  agent_slug_filter: z.string().regex(/^[a-z][a-z0-9_-]{1,60}$/).optional(),
  status: z.enum(["success", "parse_failed", "dispatch_error"]).optional(),
  top_n: z.number().int().min(1).max(50).default(30),
});

const queryDecisionStatsInput = z.object({
  days: z.number().int().min(1).max(90).default(14),
});

const queryPendingDecisionsInput = z.object({
  days: z.number().int().min(1).max(90).default(14),
  min_age_days: z.number().int().min(0).max(90).default(3),
});

const getChannelActionInput = z.object({
  id: z.string().max(64).optional(),
  title: z.string().min(1).max(300).optional(),
  channel: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/).optional(),
});

const queryOperatorFeedbackInput = z.object({
  days: z.number().int().min(1).max(90).default(30),
  agent_slug_filter: z.string().regex(/^[a-z][a-z0-9_-]{1,60}$/).optional(),
});

const querySupportThemesInput = z.object({
  days: z.number().int().min(1).max(90).default(14),
});

const readRunOutputInput = z.object({
  agent_run_id: z.string().uuid().optional(),
  agent_slug: z.string().regex(/^[a-z][a-z0-9_-]{1,60}$/).optional(),
  include_parsed: z.boolean().default(true),
});

type SpecEntry = { description: string; schema: z.ZodTypeAny; effect: ToolEffect };

const SPECS: Record<string, SpecEntry> = {
  query_recent_runs: {
    description:
      "Read Praxis's own agent_runs table (last N days) for the current tenant. Returns up to top_n=50 rows ordered by enqueued_at DESC. Each row: {agent_run_id, agent_slug, status, started_at, recency_weight, output_excerpt (≤2KB), parsed_excerpt (≤1KB), error_excerpt (≤500B)}. tool_calls is intentionally OMITTED. Optional filters: agent_slug_filter (exact slug), status. ADAPTIVE LOOKBACK: when the requested window is thin (too few runs to cluster), the server automatically widens the read to ~45d to surface more signal; the response `lookback` field reports {requested_days, effective_days, extended, suppressed_resolved}. `recency_weight` (0..1) is 1.0 for runs inside your requested window and decays for older runs pulled in by the widen — weigh older/lower-weight runs LESS when RICE-ranking. Rows whose failure is already fixed (measured/won on the roadmap) are suppressed from the widened tail so resolved issues do not resurface. Server-byte-capped response.",
    schema: queryRecentRunsInput,
    effect: "read",
  },
  query_decision_stats: {
    description:
      "Read Praxis's own decisions table for the current tenant. Returns counts per decision_class over the last N days: {decision_class, proposed_n, runs_n, approved_n, rejected_n, acted_n, oldest_proposed_age_days}. Helps surface 'stuck in proposed' patterns. proposed_n counts DECISIONS; runs_n counts the distinct runs behind them. For a channel class one run emits one decision per action, so judge 'stuck' by runs_n — an operator who completed four of five actions is not ignoring the channel.",
    schema: queryDecisionStatsInput,
    effect: "read",
  },
  query_pending_decisions: {
    description:
      "Read decisions in 'proposed' status older than min_age_days from the current tenant. Returns up to 50 rows: {decision_id, decision_class, body_excerpt (≤500B), age_days}, plus `channel_cards`: open cards waiting on a channel's own page, grouped by channel ({channel, where, open, titles}). Channel cards are NOT in Needs you now; tell the founder the `where` page. A channel run appears ONCE, not once per action, carrying actions_in_run — so you are seeing runs, not individual actions, and the excerpt is the run's first action. This keeps a few multi-action runs from filling the window and hiding older pending work. Notably NO agent_slug — that column doesn't exist on decisions; cross-reference via decision.agent_run_id if needed.",
    schema: queryPendingDecisionsInput,
    effect: "read",
  },
  get_channel_action: {
    description:
      "Read one channel card in ANY status (open, acted, done, dismissed) by `id`, or by exact `title` (optional `channel` slug). Returns {found, total, cards} newest first (max 5): step text, target, evidence, status, outcome, and email_copy with every email word for word on a copy-and-send email card. Use when the founder asks about a card that is not in the open queue.",
    schema: getChannelActionInput,
    effect: "read",
  },
  query_operator_feedback: {
    description:
      "HUMAN-FEEDBACK SIGNAL. Reads the tenant's OWN in-house run-feedback (agent_feedback table): thumbs up/down (CSAT) + 1-line operator/trainer comments on this tenant's agent runs & decisions, last N days (default 30). Returns aggregate per-agent CSAT {agent_slug, thumbs_up, thumbs_down, total, pct_positive} + the lowest-rated agents + recent thumbs-down/comment SAMPLES (comment text excerpted, scrubbed). Use this to ANCHOR backlog items on what HUMANS said about agent output (a thumbs-down on a faithful answer is signal faithfulness can't see), not just what agents DID. NOT external PII — these are the tenant's own run reactions. Empty result (no feedback yet) is normal: proceed on the internal corpus.",
    schema: queryOperatorFeedbackInput,
    effect: "read",
  },
  query_support_themes: {
    description:
      "END-USER VOICE — REDACTED support-theme digest. For Slack-wired tenants, returns AGGREGATE topic counts + a couple of PII-SCRUBBED representative snippets per theme over the tenant's recent Slack messages (default 14d). PII (emails, names, phones, cards, tokens) is removed SERVER-SIDE before this ever reaches you — you see counts + scrubbed snippets ONLY, never raw threads. Use it to surface what USERS are actually talking about (recurring support topics) as a backlog anchor, with human-feedback evidence. Empty result (no Slack indexed / killed) is normal: proceed on the internal corpus. v1 = redacted aggregates, NOT raw thread reads.",
    schema: querySupportThemesInput,
    effect: "read",
  },
  read_run_output: {
    description:
      "Read ANOTHER agent's FULL run output for the current tenant — use this when the operator says 'take the content the SEO/content agent generated' / 'use what research wrote' / 'pull the draft X made' and the actual copy is NOT pasted in this thread. Unlike query_recent_runs (which returns ≤2KB metadata EXCERPTS), this returns the COMPLETE body so you can render it VERBATIM. Provide `agent_run_id` (exact) OR `agent_slug` (e.g. 'content-design' → returns that agent's MOST-RECENT successful run). Returns {found, agent_run_id, agent_slug, status, started_at, output_text (full, ≤64KB), parsed (the structured envelope, e.g. {rendered_markdown, recommendations} — omitted when include_parsed=false), truncated}. found:false means no matching run for THIS tenant — do NOT fabricate content, ask the operator to paste it. Same-tenant only; cross-agent by design.",
    schema: readRunOutputInput,
    effect: "read",
  },
};

export function listPraxisCorpusTools(): McpTool[] {
  return Object.entries(SPECS).map(([tool_name, spec]) => {
    const schema = zodToJsonSchema(spec.schema);
    if (schema.type !== "object") {
      throw new Error(`praxis_corpus/${tool_name} input schema must be a top-level z.object()`);
    }
    return {
      server_id: "praxis_corpus",
      tool_name,
      description: spec.description,
      effect: spec.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callPraxisCorpusTool(
  tenant_id: string,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const spec = SPECS[tool_name];
  if (!spec) {
    return errorResult(start, "tool_unknown", `praxis_corpus/${tool_name} not registered`);
  }
  try {
    const parsed = spec.schema.parse(args);
    if (tool_name === "query_recent_runs") {
      const out = await runQueryRecentRuns(tenant_id, parsed as z.infer<typeof queryRecentRunsInput>);
      return okResult(start, out);
    }
    if (tool_name === "query_decision_stats") {
      const out = await runQueryDecisionStats(tenant_id, parsed as z.infer<typeof queryDecisionStatsInput>);
      return okResult(start, out);
    }
    if (tool_name === "query_pending_decisions") {
      const out = await runQueryPendingDecisions(tenant_id, parsed as z.infer<typeof queryPendingDecisionsInput>);
      return okResult(start, out);
    }
    if (tool_name === "get_channel_action") {
      const q = parsed as z.infer<typeof getChannelActionInput>;
      if (!q.id && !q.title) {
        return errorResult(start, "tool_input_invalid", "get_channel_action needs `id` or `title`");
      }
      let lookup;
      try {
        lookup = await resolveChannelAction(tenant_id, q.id ? { id: q.id } : { title: q.title, channel_slug: q.channel });
      } catch (e) {
        throw new ExpectedToolError("praxis_corpus_query_failed", (e as Error).message);
      }
      return okResult(start, enforceResponseCap({ found: lookup.matches.length > 0, total: lookup.total, cards: lookup.matches }));
    }
    if (tool_name === "query_operator_feedback") {
      const out = await runQueryOperatorFeedback(tenant_id, parsed as z.infer<typeof queryOperatorFeedbackInput>);
      return okResult(start, out);
    }
    if (tool_name === "query_support_themes") {
      const out = await runQuerySupportThemes(tenant_id, parsed as z.infer<typeof querySupportThemesInput>);
      return okResult(start, out);
    }
    if (tool_name === "read_run_output") {
      const out = await runReadRunOutput(tenant_id, parsed as z.infer<typeof readRunOutputInput>);
      return okResult(start, out);
    }
    return errorResult(start, "tool_unknown", `praxis_corpus/${tool_name} not registered`);
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      return errorResult(start, e.code, e.message);
    }
    if ((e as { name?: string })?.name === "ZodError") {
      return errorResult(start, "tool_input_invalid", (e as Error).message);
    }
    throw e;
  }
}

async function fetchRecentRunsWindow(
  tenant_id: string,
  input: z.infer<typeof queryRecentRunsInput>,
  days: number,
): Promise<{ rows: AdaptiveRunRow[]; count: number }> {
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const sb = serviceClient();
  let q = sb
    .from("agent_runs")
    .select("id, agent_slug, status, started_at, enqueued_at, output_text, parsed, error", { count: "exact" })
    .eq("tenant_id", tenant_id)
    .neq("agent_definition_hash", "seed-synthetic")
    .gte("enqueued_at", since);
  if (input.agent_slug_filter) q = q.eq("agent_slug", input.agent_slug_filter);
  if (input.status) q = q.eq("status", input.status);
  q = q.order("enqueued_at", { ascending: false }).limit(input.top_n);

  const { data, count, error } = await q;
  if (error) {
    throw new ExpectedToolError("praxis_corpus_query_failed", `agent_runs query failed: ${error.message}`);
  }
  const rows = (data ?? []) as AdaptiveRunRow[];
  return { rows, count: count ?? rows.length };
}

async function runQueryRecentRuns(
  tenant_id: string,
  input: z.infer<typeof queryRecentRunsInput>,
): Promise<unknown> {
  const requestedDays = input.days;

  const base = await fetchRecentRunsWindow(tenant_id, input, requestedDays);

  let effectiveRows = base.rows;
  let effectiveCount = base.count;
  let effectiveDays = requestedDays;
  let extended = false;
  if (
    isThinCorpus(base.count) &&
    requestedDays < EXTENDED_LOOKBACK_DAYS
  ) {
    const widened = await fetchRecentRunsWindow(tenant_id, input, EXTENDED_LOOKBACK_DAYS);
    if (widened.count > base.count) {
      effectiveRows = widened.rows;
      effectiveCount = widened.count;
      effectiveDays = EXTENDED_LOOKBACK_DAYS;
      extended = true;
    }
  }

  const resolvedSignatures = extended
    ? await loadResolvedSignatures(tenant_id)
    : new Set<string>();

  const { rows: decayedRows, suppressed } = applyDecayAndSuppression(
    effectiveRows,
    requestedDays,
    resolvedSignatures,
  );

  const rows = decayedRows.map((r) => ({
    agent_run_id: r.id,
    agent_slug: r.agent_slug,
    status: r.status,
    started_at: r.started_at ?? r.enqueued_at,
    recency_weight: Number(r.recency_weight.toFixed(3)),
    output_excerpt: excerpt(r.output_text ?? "", OUTPUT_EXCERPT_BYTES),
    parsed_excerpt: excerpt(stringifySafe(r.parsed), PARSED_EXCERPT_BYTES),
    error_excerpt: excerpt(r.error ?? "", ERROR_EXCERPT_BYTES),
  }));

  const lookback: AdaptiveLookbackMeta = {
    requested_days: requestedDays,
    effective_days: effectiveDays,
    extended,
    suppressed_resolved: suppressed,
  };

  return enforceResponseCap({
    rows,
    truncated: effectiveCount > rows.length + suppressed,
    total_runs_seen: effectiveCount,
    lookback,
  });
}

const PENDING_ROW_CAP = 50;
const PENDING_FETCH_CAP = 300;

export type PendingRow = {
  decision_id: string;
  decision_class: string;
  agent_run_id?: string | null;
  body?: unknown;
  [k: string]: unknown;
};

export function collapseChannelRuns<T extends PendingRow>(
  rows: ReadonlyArray<T>,
): Array<T & { actions_in_run?: number }> {
  const out: Array<T & { actions_in_run?: number }> = [];
  const firstOfRun = new Map<string, T & { actions_in_run?: number }>();
  for (const row of rows) {
    if (!row.decision_class.startsWith("channel.") || !row.agent_run_id) {
      out.push(row);
      continue;
    }
    const key = `${row.decision_class}::${row.agent_run_id}`;
    const seen = firstOfRun.get(key);
    if (seen) {
      seen.actions_in_run = (seen.actions_in_run ?? 1) + 1;
      continue;
    }
    const head = { ...row, actions_in_run: 1 };
    firstOfRun.set(key, head);
    out.push(head);
  }
  return out;
}

async function runQueryDecisionStats(
  tenant_id: string,
  input: z.infer<typeof queryDecisionStatsInput>,
): Promise<unknown> {
  const since = new Date(Date.now() - input.days * 86400 * 1000).toISOString();
  const sb = serviceClient();
  const { data, error } = await sb
    .from("decisions")
    .select("decision_class, status, emitted_at, agent_run_id")
    .eq("tenant_id", tenant_id)
    .gte("emitted_at", since)
    .limit(2000);
  if (error) {
    throw new ExpectedToolError("praxis_corpus_query_failed", `decisions query failed: ${error.message}`);
  }

  type Bucket = {
    decision_class: string;
    proposed_n: number;
    approved_n: number;
    rejected_n: number;
    acted_n: number;
    oldest_proposed: number;
    proposed_runs: Set<string>;
  };
  const buckets = new Map<string, Bucket>();
  const now = Date.now();
  for (const row of (data ?? []) as Array<{
    decision_class: string;
    status: string;
    emitted_at: string;
    agent_run_id: string | null;
  }>) {
    let b = buckets.get(row.decision_class);
    if (!b) {
      b = {
        decision_class: row.decision_class,
        proposed_n: 0,
        approved_n: 0,
        rejected_n: 0,
        acted_n: 0,
        oldest_proposed: Number.POSITIVE_INFINITY,
        proposed_runs: new Set<string>(),
      };
      buckets.set(row.decision_class, b);
    }
    if (row.status === "proposed") {
      b.proposed_n += 1;
      if (row.agent_run_id) b.proposed_runs.add(row.agent_run_id);
      const ts = Date.parse(row.emitted_at);
      if (Number.isFinite(ts) && ts < b.oldest_proposed) b.oldest_proposed = ts;
    } else if (row.status === "approved") b.approved_n += 1;
    else if (row.status === "rejected") b.rejected_n += 1;
    else if (row.status === "acted") b.acted_n += 1;
  }

  const by_class = [...buckets.values()]
    .map((b) => ({
      decision_class: b.decision_class,
      proposed_n: b.proposed_n,
      runs_n: b.proposed_runs.size,
      approved_n: b.approved_n,
      rejected_n: b.rejected_n,
      acted_n: b.acted_n,
      oldest_proposed_age_days:
        b.proposed_n === 0 || !Number.isFinite(b.oldest_proposed)
          ? null
          : Math.round((now - b.oldest_proposed) / 86400 / 1000),
    }))
    .sort((a, b) => b.proposed_n + b.approved_n - (a.proposed_n + a.approved_n))
    .slice(0, 30);

  return enforceResponseCap({ by_class });
}

async function runQueryPendingDecisions(
  tenant_id: string,
  input: z.infer<typeof queryPendingDecisionsInput>,
): Promise<unknown> {
  const sinceLookback = new Date(Date.now() - input.days * 86400 * 1000).toISOString();
  const olderThan = new Date(Date.now() - input.min_age_days * 86400 * 1000).toISOString();
  const sb = serviceClient();
  const { data, error } = await sb
    .from("decisions")
    .select("id, decision_class, agent_run_id, body, emitted_at")
    .eq("tenant_id", tenant_id)
    .eq("status", "proposed")
    .gte("emitted_at", sinceLookback)
    .lte("emitted_at", olderThan)
    .order("emitted_at", { ascending: true })
    .limit(PENDING_FETCH_CAP);
  if (error) {
    throw new ExpectedToolError("praxis_corpus_query_failed", `pending decisions query failed: ${error.message}`);
  }

  const now = Date.now();
  const mapped = (
    (data ?? []) as Array<{
      id: string;
      decision_class: string;
      agent_run_id: string | null;
      body: unknown;
      emitted_at: string;
    }>
  ).map((r) => ({
    decision_id: r.id,
    decision_class: r.decision_class,
    agent_run_id: r.agent_run_id,
    body_excerpt: excerpt(stringifySafe(r.body), DECISION_BODY_EXCERPT_BYTES),
    age_days: Math.round((now - Date.parse(r.emitted_at)) / 86400 / 1000),
  }));

  const rows = collapseChannelRuns(mapped).slice(0, PENDING_ROW_CAP);

  return enforceResponseCap({ rows, channel_cards: await readOpenChannelCards(tenant_id) });
}

const CHANNEL_CARD_TITLES = 5;
const CHANNEL_NAME: ReadonlyMap<string, string> = new Map(CHANNELS.map((c) => [c.slug, c.name]));

async function readOpenChannelCards(
  tenant_id: string,
): Promise<Array<{ channel: string; where: string; open: number; titles: string[] }>> {
  const { data, error } = await serviceClient()
    .from(OPEN_CHANNEL_ACTIONS_VIEW)
    .select("channel_slug, title, proposed_at")
    .eq("tenant_id", tenant_id)
    .order("proposed_at", { ascending: false })
    .limit(PENDING_FETCH_CAP);
  if (error) {
    console.warn(`[praxis_corpus] open channel cards read failed for ${tenant_id}: ${error.message}`);
    return [];
  }
  const byChannel = new Map<string, { open: number; titles: string[] }>();
  for (const r of (data ?? []) as Array<{ channel_slug: string; title: string | null }>) {
    const g = byChannel.get(r.channel_slug) ?? { open: 0, titles: [] };
    g.open += 1;
    if (r.title && g.titles.length < CHANNEL_CARD_TITLES) g.titles.push(excerpt(r.title, 160));
    byChannel.set(r.channel_slug, g);
  }
  return [...byChannel].map(([slug, g]) => {
    const name = CHANNEL_NAME.get(slug) ?? slug;
    return { channel: slug, where: `Channels → ${name}`, open: g.open, titles: g.titles };
  });
}

async function runQueryOperatorFeedback(
  tenant_id: string,
  input: z.infer<typeof queryOperatorFeedbackInput>,
): Promise<unknown> {
  const since = new Date(Date.now() - input.days * 86400 * 1000).toISOString();
  const sb = serviceClient();
  let q = sb
    .from("agent_feedback")
    .select("agent_slug, target_type, rating, comment, created_at")
    .eq("tenant_id", tenant_id)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (input.agent_slug_filter) q = q.eq("agent_slug", input.agent_slug_filter);

  const { data, error } = await q;
  if (error) {
    throw new ExpectedToolError(
      "praxis_corpus_query_failed",
      `agent_feedback query failed: ${error.message}`,
    );
  }

  type Row = {
    agent_slug: string;
    target_type: string;
    rating: number | null;
    comment: string | null;
    created_at: string;
  };
  const rows = (data ?? []) as Row[];

  type Bucket = { agent_slug: string; thumbs_up: number; thumbs_down: number };
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    let b = buckets.get(r.agent_slug);
    if (!b) {
      b = { agent_slug: r.agent_slug, thumbs_up: 0, thumbs_down: 0 };
      buckets.set(r.agent_slug, b);
    }
    if (r.rating === 1) b.thumbs_up += 1;
    else if (r.rating === -1) b.thumbs_down += 1;
  }

  const by_agent = [...buckets.values()]
    .map((b) => {
      const total = b.thumbs_up + b.thumbs_down;
      return {
        agent_slug: b.agent_slug,
        thumbs_up: b.thumbs_up,
        thumbs_down: b.thumbs_down,
        total,
        pct_positive: total > 0 ? Math.round((b.thumbs_up / total) * 100) / 100 : null,
      };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 30);

  const lowest_rated_agents = by_agent
    .filter((a) => a.total >= 3 && a.pct_positive !== null)
    .sort((a, b) => (a.pct_positive! - b.pct_positive!) || b.total - a.total)
    .slice(0, 5);

  const samples = rows
    .filter((r) => r.rating === -1 || (typeof r.comment === "string" && r.comment.trim().length > 0))
    .slice(0, FEEDBACK_MAX_COMMENTS)
    .map((r) => ({
      agent_slug: r.agent_slug,
      target_type: r.target_type,
      rating: r.rating,
      comment_excerpt:
        typeof r.comment === "string" && r.comment.trim().length > 0
          ? scrubAndCap(r.comment, FEEDBACK_COMMENT_EXCERPT_CHARS)
          : null,
      created_at: r.created_at,
    }));

  return enforceResponseCap({
    window_days: input.days,
    feedback_rows_seen: rows.length,
    by_agent,
    lowest_rated_agents,
    samples,
  });
}

async function runQuerySupportThemes(
  tenant_id: string,
  input: z.infer<typeof querySupportThemesInput>,
): Promise<unknown> {
  const sb = serviceClient();

  const { data: killState, error: killErr } = await sb
    .from("tenant_slack_index_state")
    .select("disabled_at")
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (killErr) {
    return enforceResponseCap({
      window_days: input.days,
      available: false,
      reason: "slack_index_state_unreadable",
      themes: [],
    });
  }
  if (killState?.disabled_at) {
    return enforceResponseCap({
      window_days: input.days,
      available: false,
      reason: "slack_index_disabled",
      themes: [],
    });
  }

  const since = new Date(Date.now() - input.days * 86400 * 1000).toISOString();
  const { data, error } = await sb
    .from("slack_message_index")
    .select("text_redacted, conversation_type, created_at")
    .eq("tenant_id", tenant_id)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(SUPPORT_THEME_MAX_ROWS_SCANNED);
  if (error) {
    throw new ExpectedToolError(
      "praxis_corpus_query_failed",
      `slack_message_index query failed: ${error.message}`,
    );
  }

  type Row = { text_redacted: string | null; conversation_type: string; created_at: string };
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) {
    return enforceResponseCap({
      window_days: input.days,
      available: true,
      messages_seen: 0,
      themes: [],
    });
  }

  const themes = clusterSupportThemes(rows.map((r) => r.text_redacted ?? ""));

  return enforceResponseCap({
    window_days: input.days,
    available: true,
    messages_seen: rows.length,
    themes,
  });
}

const SUPPORT_THEME_TAXONOMY: ReadonlyArray<{ theme: string; terms: readonly string[] }> = [
  { theme: "billing / payments", terms: ["bill", "billing", "invoice", "charge", "charged", "refund", "payment", "subscription", "pricing", "card declined", "overcharge"] },
  { theme: "login / auth / access", terms: ["login", "log in", "sign in", "signin", "password", "reset", "locked out", "can't access", "cannot access", "2fa", "sso", "auth"] },
  { theme: "bug / error / broken", terms: ["bug", "error", "broken", "crash", "doesn't work", "not working", "fails", "failed", "500", "exception", "glitch"] },
  { theme: "onboarding / setup", terms: ["onboard", "setup", "set up", "getting started", "connect", "integration", "install", "configure"] },
  { theme: "feature request / missing", terms: ["feature request", "wish", "would be great", "can you add", "missing", "please add", "support for", "roadmap"] },
  { theme: "performance / slow", terms: ["slow", "lag", "laggy", "timeout", "timed out", "loading", "performance", "freeze"] },
  { theme: "data / sync / export", terms: ["sync", "export", "import", "data missing", "wrong data", "duplicate", "stale", "out of date"] },
  { theme: "cancel / churn", terms: ["cancel", "cancellation", "downgrade", "churn", "leaving", "unsubscribe", "switch to"] },
];

function clusterSupportThemes(redactedTexts: string[]): Array<{
  theme: string;
  count: number;
  sample_snippets: string[];
}> {
  const buckets = new Map<string, { count: number; snippets: string[] }>();
  for (const raw of redactedTexts) {
    if (!raw || raw.trim().length === 0) continue;
    const lower = raw.toLowerCase();
    for (const { theme, terms } of SUPPORT_THEME_TAXONOMY) {
      if (!terms.some((t) => lower.includes(t))) continue;
      let b = buckets.get(theme);
      if (!b) {
        b = { count: 0, snippets: [] };
        buckets.set(theme, b);
      }
      b.count += 1;
      if (b.snippets.length < SUPPORT_THEME_SNIPPETS_PER_THEME) {
        b.snippets.push(scrubAndCap(raw, SUPPORT_THEME_SNIPPET_CHARS));
      }
    }
  }
  return [...buckets.entries()]
    .map(([theme, b]) => ({ theme, count: b.count, sample_snippets: b.snippets }))
    .sort((a, b) => b.count - a.count)
    .slice(0, SUPPORT_THEME_MAX_THEMES);
}

function scrubAndCap(text: string, maxChars: number): string {
  const scrubbed = scrubQueryForCapture(text).replace(/\s+/g, " ").trim();
  if (scrubbed.length <= maxChars) return scrubbed;
  return scrubbed.slice(0, maxChars) + "…";
}

async function runReadRunOutput(
  tenant_id: string,
  input: z.infer<typeof readRunOutputInput>,
): Promise<unknown> {
  if (!input.agent_run_id && !input.agent_slug) {
    throw new ExpectedToolError(
      "tool_input_invalid",
      "read_run_output requires agent_run_id or agent_slug",
    );
  }

  const sb = serviceClient();
  let q = sb
    .from("agent_runs")
    .select("id, agent_slug, status, started_at, enqueued_at, output_text, parsed")
    .eq("tenant_id", tenant_id)
    .neq("agent_definition_hash", "seed-synthetic");

  if (input.agent_run_id) {
    q = q.eq("id", input.agent_run_id).limit(1);
  } else {
    q = q
      .eq("agent_slug", input.agent_slug as string)
      .eq("status", "success")
      .order("enqueued_at", { ascending: false })
      .limit(1);
  }

  const { data, error } = await q;
  if (error) {
    throw new ExpectedToolError(
      "praxis_corpus_query_failed",
      `agent_runs read failed: ${error.message}`,
    );
  }

  const row = ((data ?? []) as Array<{
    id: string;
    agent_slug: string;
    status: string;
    started_at: string | null;
    enqueued_at: string;
    output_text: string | null;
    parsed: unknown;
  }>)[0];

  if (!row) {
    return enforceResponseCap({ found: false });
  }

  const out = capWithFlag(row.output_text ?? "", PEER_CONTENT_CAP);
  const parsedCapped = input.include_parsed
    ? capWithFlag(stringifySafe(row.parsed), PEER_CONTENT_CAP)
    : { text: "", truncated: false };

  return enforceResponseCap({
    found: true,
    agent_run_id: row.id,
    agent_slug: row.agent_slug,
    status: row.status,
    started_at: row.started_at ?? row.enqueued_at,
    output_text: out.text,
    ...(input.include_parsed ? { parsed: parsedCapped.text } : {}),
    truncated: out.truncated || parsedCapped.truncated,
  });
}

function excerpt(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…[truncated]";
}

function capWithFlag(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + "…[truncated]", truncated: true };
}

function stringifySafe(v: unknown): string {
  try {
    if (v == null) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return "";
  }
}

function enforceResponseCap<T>(payload: T): T {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf-8") > MAX_RESPONSE_BYTES) {
    throw new ExpectedToolError(
      "praxis_corpus_response_oversized",
      `response > ${MAX_RESPONSE_BYTES} bytes; reduce top_n or shrink lookback`,
    );
  }
  return payload;
}

function okResult(start: number, payload: unknown): McpCallResult {
  return {
    ok: true,
    is_error: false,
    content: JSON.stringify(payload),
    ms: Date.now() - start,
  };
}

function errorResult(start: number, code: string, message: string): McpCallResult {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({ error: code, message }),
    ms: Date.now() - start,
  };
}
