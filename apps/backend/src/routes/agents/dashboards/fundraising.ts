import type { DashboardBuilder } from "./_contract";
import { fundraisingPipelineEnabled } from "@/services/fundraising/flag";
import { identityKey } from "@/agents/fundraising/materialize";
import { getBoolSetting } from "@/services/settings";
import {
  resolveRaise,
  type RaiseRow,
  type ReadinessSnapshot,
  type RoundDesignSnapshot,
  type ResolverInvestor,
  type ResolverIntro,
  type ResolverMeeting,
} from "@/services/fundraising/raise-resolver";

type ArtifactChip = {
  id: string;
  filename: string;
};

type RunRow = {
  run_id: string;
  investors_count: number;
  tier1_count: number;
  tier2_count: number;
  tier3_count: number;
  generated_at: string | null;
  has_csv: boolean;
  artifact: ArtifactChip | null;
};

type ActiveRun = {
  run_id: string;
  status: "queued" | "running";
  enqueued_at: string | null;
  started_at: string | null;
  target_stage: string;
};

export type InvestorRow = {
  firm: string;
  name: string;
  tier: number;
  focus: string;
  stage_focus: string;
  check_size: string;
  fit_rationale: string;
  contact_hint: string;
  suggested_message: string;
  source: string;
  source_url: string;
  source_kind: string;
  has_draft: boolean;
  source_excerpt: string;
  identity_key?: string;
  dossier?: unknown;
  outreach_state?: string | null;
  last_sent_at?: string | null;
  durable_email?: string | null;
  review_key?: string;
  review_state?: "undecided" | "approved" | "saved" | "removed";
  channel_segment?: string;
  channel_draft?: string;
  sent_markers?: Array<{ channel: string; sent_at: string }>;
  replied?: boolean;
  followup_due?: boolean;
  days_since_sent?: number | null;
  followup_1?: string;
};

const FOLLOWUP_DAYS = 3;

type RaiseIntroDisplay = {
  id: string;
  target_firm: string;
  target_person?: string;
  path?: string;
  status: "queued" | "sent";
  draft?: string;
};

type RaiseMeetingDisplay = {
  id: string;
  investor_ref: string;
  kind: "upcoming" | "done";
  scheduled_for?: string | null;
  outcome?: "soft_yes" | "maybe" | "pass" | null;
};

type DurableInvestor = {
  firm: string | null;
  name: string | null;
  email: string | null;
  outreach_state: string | null;
  last_sent_at: string | null;
  notes?: string | null;
  draft_body?: string | null;
  source?: string | null;
};

const MAX_INVESTOR_ROWS = 150;

function str(v: unknown, max = 2000): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function tierOf(v: unknown): number {
  return v === 1 || v === 2 || v === 3 ? v : 3;
}

function normalizeStage(v: unknown): string {
  const s =
    typeof v === "string"
      ? v.trim().toLowerCase().replace(/[_-]+/g, " ")
      : "";
  if (!s) return "";
  if (s === "angel") return "Angel";
  if (s === "pre seed" || s === "preseed") return "Pre-seed";
  if (s === "seed") return "Seed";
  if (s === "series a") return "Series A";
  if (
    s === "series b" ||
    s === "series b+" ||
    s === "series b plus" ||
    s === "series b and beyond"
  ) {
    return "Series B+";
  }
  return "";
}

const STAGE_RUNGS = [
  "Angel",
  "Pre-seed",
  "Seed",
  "Series A",
  "Series B+",
] as const;

const STAGE_ADJACENT: Record<string, readonly string[]> = {
  Angel: ["Pre-seed"],
  "Pre-seed": ["Angel", "Seed"],
  Seed: ["Pre-seed", "Series A"],
  "Series A": ["Seed", "Series B+"],
  "Series B+": ["Series A"],
};

export function stagesMentioned(text: unknown): Set<string> {
  const found = new Set<string>();
  if (typeof text !== "string" || !text.trim()) return found;

  let hay = text
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/[_/,]+/g, " ")
    .replace(/\s+/g, " ");

  if (/series\s*b/.test(hay)) found.add("Series B+");
  if (/series\s*a/.test(hay)) found.add("Series A");
  if (/\bangel\b/.test(hay)) found.add("Angel");

  const preSeed = /\bpre[\s-]?seed\b/g;
  if (preSeed.test(hay)) {
    found.add("Pre-seed");
    hay = hay.replace(/\bpre[\s-]?seed\b/g, " ");
  }
  if (/\bseed\b/.test(hay)) found.add("Seed");

  return found;
}

export type StageFit = "match" | "adjacent" | "mismatch" | "unknown";

export function stageFitOf(configured: string, stageFocus: unknown): StageFit {
  const want = normalizeStage(configured);
  if (!want) return "unknown";
  const mentioned = stagesMentioned(stageFocus);
  if (mentioned.size === 0) return "unknown";
  if (mentioned.has(want)) return "match";
  const near = STAGE_ADJACENT[want] ?? [];
  if (near.some((s) => mentioned.has(s))) return "adjacent";
  return "mismatch";
}

const ANGEL_SIGNAL = /\bangels?\b|solo[\s-]?capitalists?|\bindividual\b|\bsyndicates?\b/i;

export function hasAngelSizedCheck(checkSize: string): boolean {
  const text = checkSize.replace(/(\d),(?=\d{3}\b)/g, "$1");
  return text.split(/[;,]/).some((range) => {
    if (!range.includes("$")) return false;
    const parts = [
      ...range.matchAll(/(\d+(?:\.\d+)?)\s?(k|thousand|mm|mn|m|million)?\b/gi),
    ].map((m) => ({
      n: Number(m[1]),
      unit: (m[2] ?? "").toLowerCase().startsWith("m") ? "m" : m[2] ? "k" : "",
    }));
    let unit = "";
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].unit) unit = parts[i].unit;
      else if (parts[i].n < 1000) parts[i].unit = unit;
    }
    const amounts = parts.map(
      (p) => p.n * (p.unit === "k" ? 1e3 : p.unit === "m" ? 1e6 : 1),
    );
    return amounts.length > 0 && Math.max(...amounts) <= 100_000;
  });
}

function fitsAngelRound(inv: InvestorRow): boolean {
  if (inv.firm.trim().length === 0 && inv.name.trim().length > 0) return true;
  if (ANGEL_SIGNAL.test(inv.stage_focus)) return true;
  return ANGEL_SIGNAL.test(inv.focus) && hasAngelSizedCheck(inv.check_size);
}

export function demoteOffRoundTier1(
  investors: InvestorRow[],
  configuredStage = "",
): InvestorRow[] {
  const want = normalizeStage(configuredStage);
  if (!want) return investors;
  return investors.map((inv) => {
    if (inv.tier !== 1) return inv;
    const fits =
      want === "Angel"
        ? fitsAngelRound(inv)
        : stageFitOf(want, inv.stage_focus) !== "mismatch";
    if (fits) return inv;
    return {
      ...inv,
      tier: 2,
      fit_rationale: `Moved out of Tier 1: does not fit your ${want} round.${
        inv.fit_rationale ? ` Earlier note: ${inv.fit_rationale}` : ""
      }`.slice(0, 600),
    };
  });
}

const CHANNEL_SEGMENTS = new Set([
  "email-ready",
  "linkedin-only",
  "warm-intro",
  "missing-contact",
  "do-not-contact",
]);

function channelDraftFor(segment: string, copyVariants: unknown): string {
  if (!copyVariants || typeof copyVariants !== "object") return "";
  const cv = copyVariants as Record<string, unknown>;
  if (segment === "email-ready") {
    const ce = (cv.cold_email ?? null) as Record<string, unknown> | null;
    if (!ce || typeof ce !== "object") return "";
    const subject = str(ce.subject, 200).trim();
    const bodyText = str(ce.body, 8000).trim();
    if (!subject && !bodyText) return "";
    return subject ? `Subject: ${subject}\n\n${bodyText}`.trim() : bodyText;
  }
  if (segment === "linkedin-only") return str(cv.linkedin_dm, 1500).trim();
  if (segment === "warm-intro") return str(cv.warm_intro_blurb, 1500).trim();
  return "";
}

function toInvestorRow(inv: unknown): InvestorRow {
  const o = (inv ?? {}) as Record<string, unknown>;
  const suggested = str(o.suggested_message);
  const source = str(o.source, 40);
  const isWeb = source === "web";
  const evidenceSpan = isWeb ? str(o.evidence_span, 400).trim() : "";
  const evidenceText = isWeb ? str(o.evidence_text, 600).trim() : "";
  const segRaw = str(o.channel_segment, 40).trim();
  const channelSegment = CHANNEL_SEGMENTS.has(segRaw) ? segRaw : "";
  const channelDraft = channelSegment
    ? channelDraftFor(channelSegment, o.copy_variants)
    : "";
  const cv =
    o.copy_variants && typeof o.copy_variants === "object"
      ? (o.copy_variants as Record<string, unknown>)
      : null;
  const followup1 = cv ? str(cv.followup_1, 4000).trim() : "";
  return {
    firm: str(o.firm, 300),
    name: str(o.name, 200),
    tier: tierOf(o.tier),
    focus: str(o.focus, 600),
    stage_focus: str(o.stage_focus, 300),
    check_size: str(o.check_size, 200),
    fit_rationale: str(o.fit_rationale, 600),
    contact_hint: str(o.contact_hint, 600),
    suggested_message: suggested,
    source,
    source_url: str(o.source_url, 600),
    source_kind: str(o.source_kind, 40),
    has_draft: suggested.trim().length > 0,
    source_excerpt: evidenceSpan || evidenceText,
    channel_segment: channelSegment,
    channel_draft: channelDraft,
    followup_1: followup1,
  };
}

function durableToInvestorRow(d: DurableInvestor): InvestorRow {
  const draft = str(d.draft_body ?? "", 8000);
  return {
    firm: str(d.firm ?? "", 300),
    name: str(d.name ?? "", 200),
    tier: 3,
    focus: "",
    stage_focus: "",
    check_size: "",
    fit_rationale: str(d.notes ?? "", 600),
    contact_hint: "",
    suggested_message: draft,
    source: str(d.source ?? "", 40),
    source_url: "",
    source_kind: "",
    has_draft: draft.trim().length > 0,
    source_excerpt: "",
    channel_segment: "",
    channel_draft: "",
    followup_1: "",
  };
}

type RankedInvestor = {
  firm: string;
  name: string;
  tier: number;
  score: number;
  reasons: string[];
  has_draft: boolean;
  contact_hint: string;
  source_url: string;
  source: string;
};

const RANKED_QUEUE_SIZE = 8;

export function scoreInvestor(
  inv: InvestorRow,
  configuredStage = "",
): {
  score: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  const tierWeight = inv.tier === 1 ? 100 : inv.tier === 2 ? 50 : 20;
  reasons.push(`Tier ${inv.tier}`);

  const reachable =
    inv.contact_hint.trim().length > 0 || inv.source_url.trim().length > 0;
  const draftReady = inv.has_draft;
  const sourced = inv.source === "investor_db" || inv.source_url.trim().length > 0;

  let score = tierWeight;

  const fit =
    normalizeStage(configuredStage) === "Angel" && fitsAngelRound(inv)
      ? "match"
      : stageFitOf(configuredStage, inv.stage_focus);
  if (fit === "match") {
    score += 40;
    reasons.push(`Fits ${normalizeStage(configuredStage)}`);
  } else if (fit === "adjacent") {
    score += 15;
    reasons.push(`Near ${normalizeStage(configuredStage)}`);
  } else if (fit === "mismatch") {
    score -= 25;
    reasons.push(`Off-stage for ${normalizeStage(configuredStage)}`);
  }

  if (reachable) {
    score += 20;
    reasons.push("Reachable");
  }
  if (draftReady) {
    score += 15;
    reasons.push("Draft ready");
  }
  if (sourced) {
    score += 10;
    reasons.push("Source-backed");
  }
  return { score, reasons };
}

export function orderInvestors(
  investors: InvestorRow[],
  configuredStage = "",
): InvestorRow[] {
  return investors
    .map((inv) => ({ inv, score: scoreInvestor(inv, configuredStage).score }))
    .sort((a, b) => {
      if (a.inv.tier !== b.inv.tier) return a.inv.tier - b.inv.tier;
      if (b.score !== a.score) return b.score - a.score;
      return a.inv.firm.localeCompare(b.inv.firm);
    })
    .map((x) => x.inv);
}

export function rankInvestors(
  investors: InvestorRow[],
  configuredStage = "",
): RankedInvestor[] {
  return investors
    .map((inv) => {
      const { score, reasons } = scoreInvestor(inv, configuredStage);
      return {
        firm: inv.firm,
        name: inv.name,
        tier: inv.tier,
        score,
        reasons,
        has_draft: inv.has_draft,
        contact_hint: inv.contact_hint,
        source_url: inv.source_url,
        source: inv.source,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.tier !== b.tier) return a.tier - b.tier;
      return a.firm.localeCompare(b.firm);
    })
    .slice(0, RANKED_QUEUE_SIZE);
}

type ParsedBlock = {
  investors?: unknown;
  rendered_markdown?: unknown;
  stage?: unknown;
  gated?: unknown;
  mode?: unknown;
  cadence?: unknown;
  rollout_plan?: unknown;
  merge?: unknown;
};

type MergeSummary = {
  added: number;
  already_saved: number;
  dropped: string[];
};

function toMergeSummary(raw: unknown): MergeSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const added = m.added;
  const alreadySaved = m.already_saved;
  if (typeof added !== "number" || !Number.isFinite(added) || added < 0) {
    return null;
  }
  if (
    typeof alreadySaved !== "number" ||
    !Number.isFinite(alreadySaved) ||
    alreadySaved < 0
  ) {
    return null;
  }
  if (!Array.isArray(m.dropped)) return null;
  if (!m.dropped.every((x) => typeof x === "string")) return null;
  return {
    added: Math.trunc(added),
    already_saved: Math.trunc(alreadySaved),
    dropped: (m.dropped as string[]).map((x) => str(x, 300)),
  };
}

type RoundConfigRow = {
  ask: string | null;
  instrument: string | null;
  thesis: string | null;
  proof: string | null;
  send_mode: "off" | "test" | "live";
  stage: string | null;
  deck_url: string | null;
  review_done_at: string | null;
  last_run_requested_at: string | null;
};

type LatestStrategyPayload = {
  investors: unknown[];
  cadence: string;
  rollout_plan: string;
};

type AgentRunRow = {
  id: string;
  enqueued_at: string | null;
  parsed: unknown;
};

type ActiveAgentRunRow = {
  id: string;
  status: string | null;
  enqueued_at: string | null;
  started_at: string | null;
};

type ArtifactRow = {
  id: string;
  run_id: string;
  filename: string;
};

function countTier(investors: unknown, tier: number): number {
  if (!Array.isArray(investors)) return 0;
  let n = 0;
  for (const inv of investors) {
    if ((inv as { tier?: unknown })?.tier === tier) n += 1;
  }
  return n;
}

export const build: DashboardBuilder = async (c) => {
  let roundConfig: RoundConfigRow | null = null;
  try {
    const { data, error } = await c.sb
      .from("fundraising_round_config")
      .select(
        "ask, instrument, thesis, proof, send_mode, stage, deck_url, review_done_at, last_run_requested_at",
      )
      .eq("tenant_id", c.tenantId)
      .maybeSingle();
    if (!error && data) {
      const row = data as Record<string, unknown>;
      roundConfig = {
        ask: typeof row.ask === "string" ? row.ask : null,
        instrument: typeof row.instrument === "string" ? row.instrument : null,
        thesis: typeof row.thesis === "string" ? row.thesis : null,
        proof: typeof row.proof === "string" ? row.proof : null,
        send_mode:
          row.send_mode === "test" || row.send_mode === "live"
            ? row.send_mode
            : "off",
        stage: typeof row.stage === "string" ? row.stage : null,
        deck_url: typeof row.deck_url === "string" ? row.deck_url : null,
        review_done_at:
          typeof row.review_done_at === "string" ? row.review_done_at : null,
        last_run_requested_at:
          typeof row.last_run_requested_at === "string"
            ? row.last_run_requested_at
            : null,
      };
    }
  } catch {
    roundConfig = null;
  }
  const configuredStage = normalizeStage(roundConfig?.stage);

  const deepInFlight: Array<{ identity_key: string; run_id: string }> = [];
  try {
    const { data, error } = await c.sb
      .from("agent_runs")
      .select("id, payload")
      .eq("tenant_id", c.tenantId)
      .eq("agent_slug", "fundraising")
      .in("status", ["queued", "running"])
      .order("enqueued_at", { ascending: false })
      .limit(25);
    if (!error && Array.isArray(data)) {
      const seen = new Set<string>();
      for (const row of data as Array<{ id?: unknown; payload?: unknown }>) {
        const p = row.payload as
          | { mode?: unknown; deep?: { identity_key?: unknown } }
          | null
          | undefined;
        if (!p || p.mode !== "deep") continue;
        const key =
          typeof p.deep?.identity_key === "string" ? p.deep.identity_key.trim() : "";
        const runId = typeof row.id === "string" ? row.id : "";
        if (!key || !runId || seen.has(key)) continue;
        seen.add(key);
        deepInFlight.push({ identity_key: key, run_id: runId });
      }
    }
  } catch {
  }

  let activeRun: ActiveRun | null = null;
  try {
    const { data, error } = await c.sb
      .from("agent_runs")
      .select("id, status, enqueued_at, started_at")
      .eq("tenant_id", c.tenantId)
      .eq("agent_slug", "fundraising")
      .in("status", ["queued", "running"])
      .order("enqueued_at", { ascending: false })
      .limit(1);
    if (!error && Array.isArray(data) && data.length > 0) {
      const row = data[0] as ActiveAgentRunRow;
      const targetStage = configuredStage;
      if (row.status === "queued" || row.status === "running") {
        activeRun = {
          run_id: row.id,
          status: row.status,
          enqueued_at: row.enqueued_at ?? null,
          started_at: row.started_at ?? null,
          target_stage: targetStage,
        };
      }
    }
  } catch {
    activeRun = null;
  }

  let runs: AgentRunRow[] = [];
  try {
    const { data, error } = await c.sb
      .from("agent_runs")
      .select("id, enqueued_at, parsed")
      .eq("tenant_id", c.tenantId)
      .eq("agent_slug", "fundraising")
      .eq("status", "success")
      .order("enqueued_at", { ascending: false })
      .limit(40);
    if (error) throw error;
    runs = (data ?? []) as AgentRunRow[];
  } catch {
    return { runs: [] };
  }

  const rows: RunRow[] = [];
  let latestInvestorsRaw: unknown[] = [];
  let gatedRunId: string | null = null;
  let gatedGeneratedAt: string | null = null;
  let gatedStage = "";
  for (const r of runs) {
    const parsed = (r.parsed ?? null) as ParsedBlock | null;
    if (!parsed || !Array.isArray(parsed.investors) || parsed.investors.length === 0) {
      continue;
    }
    if (gatedRunId === null && parsed.gated === true) {
      latestInvestorsRaw = parsed.investors;
      gatedRunId = r.id;
      gatedGeneratedAt = r.enqueued_at ?? null;
      gatedStage = str(parsed.stage, 60).trim();
    }
    rows.push({
      run_id: r.id,
      investors_count: parsed.investors.length,
      tier1_count: countTier(parsed.investors, 1),
      tier2_count: countTier(parsed.investors, 2),
      tier3_count: countTier(parsed.investors, 3),
      generated_at: r.enqueued_at ?? null,
      has_csv: false,
      artifact: null,
    });
  }

  let latestMerge: MergeSummary | null = null;
  for (const r of runs) {
    const parsed = (r.parsed ?? null) as ParsedBlock | null;
    if (!parsed || parsed.gated !== true) continue;
    const mode = typeof parsed.mode === "string" ? parsed.mode : "source";
    if (mode !== "source") {
      if (gatedRunId !== null && r.id === gatedRunId) break;
      continue;
    }
    latestMerge = toMergeSummary(parsed.merge);
    break;
  }

  if (rows.length > 0) {
    try {
      const runIds = rows.map((e) => e.run_id);
      const { data, error } = await c.sb
        .from("run_artifacts")
        .select("id, run_id, filename")
        .eq("tenant_id", c.tenantId)
        .eq("mime", "text/csv")
        .in("run_id", runIds);
      if (!error && Array.isArray(data)) {
        const byRun = new Map<string, ArtifactRow>();
        for (const a of data as ArtifactRow[]) {
          if (!byRun.has(a.run_id)) byRun.set(a.run_id, a);
        }
        for (const row of rows) {
          const art = byRun.get(row.run_id);
          if (art) {
            row.has_csv = true;
            row.artifact = { id: art.id, filename: art.filename };
          }
        }
      }
    } catch {
    }
  }

  let latestStrategy: LatestStrategyPayload | null = null;
  for (const r of runs) {
    const parsed = (r.parsed ?? null) as ParsedBlock | null;
    if (!parsed || parsed.mode !== "strategy") continue;
    if (!Array.isArray(parsed.investors) || parsed.investors.length === 0) continue;
    latestStrategy = {
      investors: parsed.investors,
      cadence: str(parsed.cadence, 1000),
      rollout_plan: str(parsed.rollout_plan, 4000),
    };
    break;
  }

  const pipelineEnabled = await fundraisingPipelineEnabled(c.tenantId).catch(
    () => false,
  );
  const durableByKey = new Map<string, DurableInvestor>();
  if (pipelineEnabled) {
    try {
      const { data, error } = await c.sb.rpc("fundraising_list_investors", {
        p_tenant_id: c.tenantId,
      });
      if (!error && Array.isArray(data)) {
        for (const row of data as DurableInvestor[]) {
          const key = identityKey(row.firm ?? "", row.name ?? "");
          if (!durableByKey.has(key)) durableByKey.set(key, row);
        }
      }
    } catch {
    }
  }

  const runRowByKey = new Map<string, InvestorRow>();
  for (const r of runs) {
    const parsed = (r.parsed ?? null) as ParsedBlock | null;
    if (!parsed || parsed.gated !== true || !Array.isArray(parsed.investors)) {
      continue;
    }
    for (const raw of parsed.investors) {
      const mapped = toInvestorRow(raw);
      if (mapped.firm.length === 0 && mapped.name.length === 0) continue;
      const key = identityKey(mapped.firm, mapped.name);
      if (!runRowByKey.has(key)) runRowByKey.set(key, mapped);
    }
  }

  const merged: InvestorRow[] = latestInvestorsRaw
    .map(toInvestorRow)
    .filter((i) => i.firm.length > 0 || i.name.length > 0);
  const seenKeys = new Set(merged.map((i) => identityKey(i.firm, i.name)));
  if (pipelineEnabled) {
    for (const [key, d] of durableByKey) {
      if (seenKeys.has(key)) continue;
      const firm = str(d.firm ?? "", 300);
      const name = str(d.name ?? "", 200);
      if (firm.length === 0 && name.length === 0) continue;
      seenKeys.add(key);
      const fromRun = runRowByKey.get(key);
      merged.push(fromRun ? { ...fromRun } : durableToInvestorRow(d));
    }
  }
  const allInvestors: InvestorRow[] = demoteOffRoundTier1(
    merged,
    configuredStage,
  ).sort((a, b) => a.tier - b.tier);

  if (pipelineEnabled) {
    for (const inv of allInvestors) {
      const key = identityKey(inv.firm, inv.name);
      inv.identity_key = key;
      const durable = durableByKey.get(key) ?? null;
      inv.outreach_state = durable?.outreach_state ?? null;
      inv.last_sent_at = durable?.last_sent_at ?? null;
      inv.durable_email =
        durable?.email && durable.email.trim().length > 0
          ? durable.email
          : null;
    }
  }

  const dossierByKey = new Map<string, unknown>();
  for (const r of runs) {
    const parsed = (r.parsed ?? null) as (ParsedBlock & { deep?: unknown }) | null;
    if (!parsed || parsed.mode !== "deep") continue;
    const deep = parsed.deep as { identity_key?: unknown } | null | undefined;
    if (!deep || typeof deep !== "object") continue;
    const key = typeof deep.identity_key === "string" ? deep.identity_key.trim() : "";
    if (!key) continue;
    if (!dossierByKey.has(key)) dossierByKey.set(key, deep);
  }
  if (dossierByKey.size > 0) {
    for (const inv of allInvestors) {
      const key = inv.identity_key ?? identityKey(inv.firm, inv.name);
      const d = dossierByKey.get(key);
      if (d) inv.dossier = d as InvestorRow["dossier"];
    }
  }

  const reviewByKey = new Map<string, "undecided" | "approved" | "saved" | "removed">();
  try {
    const { data, error } = await c.sb
      .from("fundraising_review_state")
      .select("investor_id, state")
      .eq("tenant_id", c.tenantId);
    if (!error && Array.isArray(data)) {
      for (const r of data as Array<{ investor_id?: unknown; state?: unknown }>) {
        const id = typeof r.investor_id === "string" ? r.investor_id : "";
        const st = r.state;
        if (
          id &&
          (st === "undecided" ||
            st === "approved" ||
            st === "saved" ||
            st === "removed")
        ) {
          reviewByKey.set(id, st);
        }
      }
    }
  } catch {
  }
  for (const inv of allInvestors) {
    const key = identityKey(inv.firm, inv.name);
    inv.review_key = key;
    inv.review_state = reviewByKey.get(key) ?? "undecided";
  }

  const sentByKey = new Map<string, Array<{ channel: string; sent_at: string }>>();
  try {
    const { data, error } = await c.sb
      .from("fundraising_outreach_sent")
      .select("investor_id, channel, sent_at")
      .eq("tenant_id", c.tenantId);
    if (!error && Array.isArray(data)) {
      for (const r of data as Array<{
        investor_id?: unknown;
        channel?: unknown;
        sent_at?: unknown;
      }>) {
        const id = typeof r.investor_id === "string" ? r.investor_id : "";
        const channel = typeof r.channel === "string" ? r.channel : "";
        const sentAt = typeof r.sent_at === "string" ? r.sent_at : "";
        if (!id || !channel) continue;
        const list = sentByKey.get(id) ?? [];
        list.push({ channel, sent_at: sentAt });
        sentByKey.set(id, list);
      }
    }
  } catch {
  }
  for (const inv of allInvestors) {
    const key = identityKey(inv.firm, inv.name);
    inv.sent_markers = sentByKey.get(key) ?? [];
  }

  const repliedKeys = new Set<string>();
  try {
    const { data, error } = await c.sb
      .from("fundraising_outreach_replied")
      .select("investor_id")
      .eq("tenant_id", c.tenantId);
    if (!error && Array.isArray(data)) {
      for (const r of data as Array<{ investor_id?: unknown }>) {
        const id = typeof r.investor_id === "string" ? r.investor_id : "";
        if (id) repliedKeys.add(id);
      }
    }
  } catch {
  }
  const nowMs = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  let followupsDueCount = 0;
  for (const inv of allInvestors) {
    const key = identityKey(inv.firm, inv.name);
    const replied = repliedKeys.has(key);
    inv.replied = replied;
    const markers = inv.sent_markers ?? [];
    let earliestSentMs: number | null = null;
    for (const m of markers) {
      const t = Date.parse(m.sent_at);
      if (!Number.isNaN(t) && (earliestSentMs === null || t < earliestSentMs)) {
        earliestSentMs = t;
      }
    }
    inv.days_since_sent =
      earliestSentMs === null
        ? null
        : Math.floor((nowMs - earliestSentMs) / DAY_MS);
    const due =
      markers.length > 0 &&
      !replied &&
      earliestSentMs !== null &&
      nowMs - earliestSentMs >= FOLLOWUP_DAYS * DAY_MS;
    inv.followup_due = due;
    if (due) followupsDueCount += 1;
  }

  let raiseState: Record<string, unknown> | null = null;
  const raiseEnabled = await getBoolSetting("raise_room_advisor", c.tenantId).catch(
    () => false,
  );
  if (raiseEnabled) {
    let raiseRow: RaiseRow = null;
    try {
      const { data, error } = await c.sb
        .from("fundraising_raise")
        .select("current_phase, readiness_snapshot, round_design_snapshot")
        .eq("tenant_id", c.tenantId)
        .maybeSingle();
      if (!error && data) {
        const row = data as Record<string, unknown>;
        raiseRow = {
          current_phase:
            typeof row.current_phase === "string" ? row.current_phase : null,
          readiness_snapshot:
            (row.readiness_snapshot as ReadinessSnapshot | null) ?? null,
          round_design_snapshot:
            (row.round_design_snapshot as RoundDesignSnapshot | null) ?? null,
        };
      }
    } catch {
      raiseRow = null;
    }
    const resolverInvestors: ResolverInvestor[] = allInvestors.map((inv) => {
      let earliestSent: string | null = inv.last_sent_at ?? null;
      for (const m of inv.sent_markers ?? []) {
        if (!earliestSent || (m.sent_at && m.sent_at < earliestSent)) {
          earliestSent = m.sent_at || earliestSent;
        }
      }
      return {
        outreach_state: inv.outreach_state ?? null,
        review_state: inv.review_state ?? null,
        replied: inv.replied === true,
        sent_marker_count: (inv.sent_markers ?? []).length,
        earliest_sent_at: earliestSent,
      };
    });
    let resolverIntros: ResolverIntro[] = [];
    let introList: RaiseIntroDisplay[] = [];
    try {
      const { data, error } = await c.sb
        .from("fundraising_raise_intro")
        .select("id, target_firm, target_person, path, status, draft_text")
        .eq("tenant_id", c.tenantId);
      if (!error && Array.isArray(data)) {
        const introRows = data as Array<{
          id?: string | null;
          target_firm?: string | null;
          target_person?: string | null;
          path?: string | null;
          status?: string | null;
          draft_text?: string | null;
        }>;
        resolverIntros = introRows.map((r) => ({ status: r.status ?? null }));
        introList = introRows
          .filter((r) => typeof r.id === "string" && r.id.length > 0)
          .map((r) => {
            const row: RaiseIntroDisplay = {
              id: r.id as string,
              target_firm: str(r.target_firm, 300),
              status: r.status === "sent" ? "sent" : "queued",
            };
            const person = str(r.target_person, 200).trim();
            if (person) row.target_person = person;
            const path = str(r.path, 600).trim();
            if (path) row.path = path;
            const draft = str(r.draft_text, 8000).trim();
            if (draft) row.draft = draft;
            return row;
          });
      }
    } catch {
      resolverIntros = [];
      introList = [];
    }
    let resolverMeetings: ResolverMeeting[] = [];
    let meetingList: RaiseMeetingDisplay[] = [];
    try {
      const { data, error } = await c.sb
        .from("fundraising_raise_meeting")
        .select("id, investor_ref, scheduled_for, status, outcome")
        .eq("tenant_id", c.tenantId);
      if (!error && Array.isArray(data)) {
        const meetingRows = data as Array<{
          id?: string | null;
          investor_ref?: string | null;
          scheduled_for?: string | null;
          status?: string | null;
          outcome?: string | null;
        }>;
        resolverMeetings = meetingRows.map((r) => ({
          kind: r.status ?? null,
          outcome: r.outcome ?? null,
        }));
        meetingList = meetingRows
          .filter((r) => typeof r.id === "string" && r.id.length > 0)
          .map((r) => {
            const outcome =
              r.outcome === "soft_yes" ||
              r.outcome === "maybe" ||
              r.outcome === "pass"
                ? r.outcome
                : null;
            const row: RaiseMeetingDisplay = {
              id: r.id as string,
              investor_ref: str(r.investor_ref, 300),
              kind: r.status === "done" ? "done" : "upcoming",
              scheduled_for: r.scheduled_for ?? null,
              outcome,
            };
            return row;
          });
      }
    } catch {
      resolverMeetings = [];
      meetingList = [];
    }
    try {
      const resolved = resolveRaise({
        raise: raiseRow,
        ask: roundConfig?.ask ?? null,
        investors: resolverInvestors,
        intros: resolverIntros,
        meetings: resolverMeetings,
        followupsDueCount,
        nowMs,
      }) as unknown as Record<string, unknown>;
      raiseState = { ...resolved, intros: introList, meetings: meetingList };
    } catch {
      raiseState = null;
    }
  }

  const reviewCounts = {
    approved: allInvestors.filter((i) => i.review_state === "approved").length,
    saved: allInvestors.filter((i) => i.review_state === "saved").length,
    removed: allInvestors.filter((i) => i.review_state === "removed").length,
    undecided: allInvestors.filter(
      (i) => (i.review_state ?? "undecided") === "undecided",
    ).length,
  };

  const orderedInvestors = orderInvestors(allInvestors, configuredStage);
  const investors = orderedInvestors.slice(0, MAX_INVESTOR_ROWS);

  const rankedQueue = rankInvestors(orderedInvestors, configuredStage);

  const gatedRow = gatedRunId ? rows.find((r) => r.run_id === gatedRunId) : null;
  const coverage = {
    total: allInvestors.length,
    tier1: allInvestors.filter((i) => i.tier === 1).length,
    drafts_ready: allInvestors.filter((i) => i.has_draft).length,
    source_backed: allInvestors.filter(
      (i) => i.source === "investor_db" || i.source_url.trim().length > 0,
    ).length,
    missing_contact: allInvestors.filter(
      (i) =>
        !(i.durable_email && i.durable_email.trim().length > 0) &&
        i.contact_hint.trim().length === 0 &&
        i.source_url.trim().length === 0,
    ).length,
  };

  const listsProduced = rows.length;
  const investorsSourced = rows.reduce((s, r) => s + r.investors_count, 0);
  const csvsGenerated = rows.filter((r) => r.has_csv).length;
  const lastSourcedIso = rows.length > 0 ? rows[0].generated_at : null;

  return {
    pipeline_enabled: pipelineEnabled,
    active_run: activeRun,
    deep_in_flight: deepInFlight,
    kpis: {
      lists_produced: listsProduced,
      investors_sourced: investorsSourced,
      csvs_generated: csvsGenerated,
      last_sourced: lastSourcedIso,
    },
    latest: gatedRow
      ? {
          run_id: gatedRow.run_id,
          generated_at: gatedGeneratedAt,
          stage: gatedStage,
          csv: gatedRow.artifact,
          investors,
          ...(latestMerge ? { merge: latestMerge } : {}),
        }
      : null,
    ranked_queue: rankedQueue,
    coverage,
    review_counts: reviewCounts,
    followups_due_count: followupsDueCount,
    runs: rows,
    round_config: roundConfig,
    latest_strategy: latestStrategy,
    ...(raiseState ? { raise: raiseState } : {}),
  };
};
