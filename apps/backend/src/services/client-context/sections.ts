import { staffCrossTenantClient } from "@/services/tenant-client";
import { METRIC_REGISTRY } from "@/services/analytics/metric-registry";
import { AI_ESTIMATED_SOURCE } from "@/services/company-profiles/fill-fields";
import { extractBrands } from "@/agents/research/persist-snapshot";
import { computeGrowthScore } from "@/services/company-profiles/growth-score";
import { PRIVATE_NOTE_TYPES_PGREST_IN } from "@/services/memory";
import type {
  AnalyticsSection,
  ChannelsSection,
  CompanyFact,
  CompanySection,
  CompanySocialProfile,
  CompetitorRow,
  CompetitorsSection,
  GoalRow,
  GoalsSection,
  MetricRow,
  ProfileField,
  Section,
} from "./types";
import { loadTrends } from "./trends";
import { goalTrajectoryView } from "@/services/growth/goal-owner";

const REASON =
  "admin suggestions workspace: read one client's context for staff curation";

function sb() {
  return staffCrossTenantClient(REASON);
}

const FACT_LABELS: Record<string, string> = {
  domain: "Website",
  what_we_sell: "What they sell",
  who_we_serve: "Who they serve",
  competitors: "Named competitors",
  signup_url: "Signup URL",
  pricing_page: "Pricing page",
};

type FactRow = {
  key: string;
  value_text: string;
  source: string;
  verified_at: string | null;
};

type SlotSpec = {
  key: string;
  label: string;
  from: (
    input: ProfileInput,
  ) => {
    value: string;
    source: string;
    observed_at: string | null;
    note?: string;
  } | null;
};

type MetricPoint = {
  value: number | null;
  source: string;
  window_end: string;
};

type SavedProfile = {
  industry: string;
  category: string;
  founded: string;
  location: string;
  social_profiles: CompanySocialProfile[];
  updated_at: string;
};

type EstimatedRow = {
  key: string;
  value: string;
  method: string;
  source: string;
  formula: string;
  assumptions: string;
  caveats: string;
  confidence: string | null;
  updated_at: string;
};

type ProfileInput = {
  estimated: Map<string, EstimatedRow>;
  tenant: {
    slug: string;
    display_name: string | null;
    product_url: unknown;
    created_at?: string | null;
  };
  facts: Map<string, FactRow>;
  metrics: Map<string, MetricPoint>;
  previous: Map<string, MetricPoint>;
  saved: SavedProfile | null;
  slackHumans: number | null;
};

export function productUrlHref(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  for (const key of ["marketing", "api"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function parseSocialProfiles(value: unknown): CompanySocialProfile[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: CompanySocialProfile[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const platform = typeof (row as { platform?: unknown }).platform === "string"
      ? (row as { platform: string }).platform.trim().toLowerCase()
      : "";
    if (!platform || seen.has(platform)) continue;
    const urlRaw = (row as { url?: unknown }).url;
    const followersRaw = (row as { followers?: unknown }).followers;
    seen.add(platform);
    out.push({
      platform,
      url: typeof urlRaw === "string" && urlRaw.trim() ? urlRaw.trim() : null,
      followers: typeof followersRaw === "string" && followersRaw.trim() ? followersRaw.trim() : null,
    });
  }
  return out;
}

function usd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000)
    return `$${(value / 1_000_000).toFixed(2).replace(/\.00$/, "")}M`;
  if (abs >= 10_000)
    return `$${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function fromFact(key: string, note?: string): SlotSpec["from"] {
  return ({ facts }) => {
    const fact = facts.get(key);
    if (!fact) return null;
    return {
      value: fact.value_text,
      source: fact.source,
      observed_at: fact.verified_at,
      note,
    };
  };
}

function fromMetric(
  key: string,
  format: (n: number) => string,
  note?: string,
): SlotSpec["from"] {
  return ({ metrics }) => {
    const metric = metrics.get(key);
    if (!metric || metric.value === null) return null;
    return {
      value: format(metric.value),
      source: metric.source,
      observed_at: metric.window_end,
      note,
    };
  };
}

function fromSaved(
  key: "industry" | "category" | "founded" | "location",
): SlotSpec["from"] {
  return ({ saved }) => {
    const value = saved?.[key]?.trim();
    if (!value) return null;
    return {
      value,
      source: "staff_reviewed",
      observed_at: saved?.updated_at ?? null,
    };
  };
}

function fromEstimated(key: string): SlotSpec["from"] {
  return ({ estimated }) => {
    const row = estimated.get(key);
    if (!row) return null;
    const note = [
      row.method === "calculated" ? "AI-calculated" : row.method === "recorded" ? "AI-recalled" : "AI-inferred",
      row.source,
      row.formula,
      row.assumptions,
      row.caveats,
      row.confidence ? `${row.confidence} confidence` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return { value: row.value, source: AI_ESTIMATED_SOURCE, observed_at: row.updated_at, note: note || undefined };
  };
}

function firstHit(...readers: SlotSpec["from"][]): SlotSpec["from"] {
  return (input) => {
    for (const reader of readers) {
      const hit = reader(input);
      if (hit) return hit;
    }
    return null;
  };
}

const SOURCE_RANK: Record<string, number> = {
  human_confirmed: 5,
  staff_reviewed: 4,
  connector: 3,
  typed_column: 3,
  provisioned: 2,
  onboarding_enrichment: 1,
  ai_estimated: 0,
};

function bestSourced(...readers: SlotSpec["from"][]): SlotSpec["from"] {
  return (input) => {
    let best: ReturnType<SlotSpec["from"]> = null;
    let bestRank = -1;
    for (const reader of readers) {
      const hit = reader(input);
      if (!hit) continue;
      const rank = SOURCE_RANK[hit.source] ?? -1;
      if (rank > bestRank) {
        best = hit;
        bestRank = rank;
      }
    }
    return best;
  };
}

const PROFILE_SLOTS: SlotSpec[] = [
  {
    key: "industry",
    label: "Industry",
    from: bestSourced(fromSaved("industry"), fromFact("industry")),
  },
  {
    key: "category",
    label: "Category",
    from: bestSourced(fromSaved("category"), fromFact("what_we_sell")),
  },
  {
    key: "company_size",
    label: "Company size",
    from: ({ slackHumans }) =>
      slackHumans && slackHumans > 0
        ? {
            value: String(slackHumans),
            source: "slack",
            observed_at: null,
            note: "Slack workspace humans",
          }
        : null,
  },
  {
    key: "founded",
    label: "Founded",
    from: bestSourced(fromSaved("founded"), fromFact("founded")),
  },
  {
    key: "location",
    label: "Location",
    from: bestSourced(fromSaved("location"), fromFact("location")),
  },
  {
    key: "growth_score",
    label: "Growth score",
    from: ({ metrics, previous }) => {
      const pairs = new Map<string, { latest: number; previous: number }>();
      for (const [key, latest] of metrics) {
        const prior = previous.get(key);
        if (latest.value === null || prior?.value == null) continue;
        pairs.set(key, { latest: latest.value, previous: prior.value });
      }
      const scored = computeGrowthScore(pairs);
      if (!scored) return null;
      return {
        value: String(scored.score),
        source: "derived",
        observed_at: null,
        note: scored.note,
      };
    },
  },
];

const ICP_SLOTS: SlotSpec[] = [
  { key: "primary_icp", label: "Primary ICP", from: fromFact("who_we_serve") },
  { key: "buyer", label: "Buyer", from: () => null },
  {
    key: "average_customer_value",
    label: "Average customer value",
    from: () => null,
  },
  { key: "target_industries", label: "Target industries", from: () => null },
  { key: "customer_segments", label: "Customer segments", from: () => null },
  { key: "personas", label: "Personas", from: () => null },
  { key: "geography", label: "Geography", from: fromSaved("location") },
];

const BUSINESS_MODEL_SLOTS: SlotSpec[] = [
  {
    key: "mrr",
    label: "MRR",
    from: fromMetric("stripe_mrr", usd, "current month"),
  },
  {
    key: "arr",
    label: "ARR",
    from: (input) => {
      const mrr = input.metrics.get("stripe_mrr");
      if (!mrr || mrr.value === null) return null;
      return {
        value: usd(mrr.value * 12),
        source: "derived",
        observed_at: mrr.window_end,
        note: "MRR × 12",
      };
    },
  },
  { key: "avg_deal_size", label: "Avg deal size", from: () => null },
  { key: "gross_margin", label: "Gross margin", from: () => null },
  {
    key: "net_revenue_retention",
    label: "Net revenue retention",
    from: () => null,
  },
  {
    key: "customer_lifetime_value",
    label: "Customer lifetime value",
    from: () => null,
  },
  {
    key: "customer_acquisition_cost",
    label: "Customer acquisition cost",
    from: fromMetric("ads_cpa_7d", usd, "paid only, last 7 days"),
  },
  { key: "ltv_cac", label: "LTV : CAC", from: () => null },
];

export const __test = {
  get PROFILE_SLOTS() {
    return PROFILE_SLOTS;
  },
  buildSlots: (specs: SlotSpec[], input: ProfileInput) => buildSlots(specs, input),
};

function buildSlots(specs: SlotSpec[], input: ProfileInput): ProfileField[] {
  return specs.map((spec) => {
    const hit = spec.from(input) ?? fromEstimated(spec.key)(input);
    return {
      key: spec.key,
      label: spec.label,
      value: hit?.value ?? null,
      source: hit?.source ?? null,
      observed_at: hit?.observed_at ?? null,
      note: hit?.note ?? null,
    };
  });
}

export async function loadCompany(
  tenant_id: string,
): Promise<Section<CompanySection>> {
  const client = sb();
  const [tenantRes, factsRes, anchorRes, connectorRes, metricRes, savedRes, slackRes, estimatedRes] =
    await Promise.all([
      client
        .from("tenants")
        .select("id, slug, display_name, product_url")
        .eq("id", tenant_id)
        .maybeSingle(),
      client
        .from("tenant_fact")
        .select("key, value_text, source, verified_at")
        .eq("tenant_id", tenant_id),
      client
        .from("memory_note")
        .select("body_markdown, updated_at, created_at")
        .eq("tenant_id", tenant_id)
        .eq("slug", "company")
        .not("note_type", "in", PRIVATE_NOTE_TYPES_PGREST_IN)
        .is("superseded_by", null)
        .maybeSingle(),
      client
        .from("connector_metadata")
        .select("slug, connected_at")
        .eq("tenant_id", tenant_id),
      client
        .from("tenant_metric_snapshots")
        .select("metric_key, value, status, source, window_end")
        .eq("tenant_id", tenant_id)
        .order("window_end", { ascending: false })
        .limit(200),
      client
        .from("company_profiles")
        .select("industry, category, founded, location, social_profiles, updated_at")
        .eq("tenant_id", tenant_id)
        .maybeSingle(),
      client
        .from("team_members")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenant_id)
        .eq("kind", "human")
        .eq("status", "active"),
      client
        .from("company_profile_fields")
        .select("key, value, method, source, formula, assumptions, caveats, confidence, updated_at")
        .eq("tenant_id", tenant_id),
    ]);

  const tenant = (tenantRes.data ?? null) as {
    id: string;
    slug: string;
    display_name: string | null;
    product_url: unknown;
  } | null;
  if (!tenant) {
    return {
      status: "not_configured",
      detail: "This client no longer exists.",
      data: {
        tenant_id,
        name: tenant_id.slice(0, 8),
        slug: "",
        domain: null,
        facts: [],
        description: null,
        description_updated_at: null,
        connected_sources: [],
        social_profiles: [],
        profile: [],
        icp: [],
        business_model: [],
        unrecorded_count: 0,
      },
      source_updated_at: null,
    };
  }

  const facts: CompanyFact[] = ((factsRes.data ?? []) as FactRow[]).map(
    (row) => ({
      key: row.key,
      label: FACT_LABELS[row.key] ?? row.key,
      value: row.value_text,
      source: row.source,
      verified_at: row.verified_at,
    }),
  );

  const anchor = (anchorRes.data ?? null) as {
    body_markdown: string | null;
    updated_at: string | null;
    created_at: string | null;
  } | null;

  const connected = (
    (connectorRes.data ?? []) as Array<{
      slug: string;
      connected_at: string | null;
    }>
  )
    .map((c) => c.slug)
    .sort();

  const domainFact = facts.find((f) => f.key === "domain")?.value ?? null;

  const metrics = new Map<string, MetricPoint>();
  const previous = new Map<string, MetricPoint>();
  for (const row of (metricRes.data ?? []) as SnapshotRow[]) {
    const point: MetricPoint = {
      value: row.status === "measured" ? toNumber(row.value) : null,
      source: row.source,
      window_end: row.window_end,
    };
    if (!metrics.has(row.metric_key)) metrics.set(row.metric_key, point);
    else if (!previous.has(row.metric_key)) previous.set(row.metric_key, point);
  }

  const savedRow = (savedRes.data ?? null) as {
    industry: string | null;
    category: string | null;
    founded: string | null;
    location: string | null;
    social_profiles: unknown;
    updated_at: string;
  } | null;
  const social_profiles = parseSocialProfiles(savedRow?.social_profiles);
  const saved: SavedProfile | null = savedRow
    ? {
        industry: savedRow.industry ?? "",
        category: savedRow.category ?? "",
        founded: savedRow.founded ?? "",
        location: savedRow.location ?? "",
        social_profiles,
        updated_at: savedRow.updated_at,
      }
    : null;
  const slackHumans = typeof slackRes.count === "number" ? slackRes.count : null;
  const estimated = new Map(
    ((estimatedRes.data ?? []) as EstimatedRow[]).map((row) => [row.key, row]),
  );

  const newest =
    [
      anchor?.updated_at ?? anchor?.created_at ?? null,
      saved?.updated_at ?? null,
      ...[...estimated.values()].map((row) => row.updated_at),
      ...facts.map((f) => f.verified_at),
    ]
      .filter((v): v is string => Boolean(v))
      .sort()
      .pop() ?? null;

  const profileInput: ProfileInput = {
    estimated,
    tenant,
    facts: new Map(
      ((factsRes.data ?? []) as FactRow[]).map((row) => [row.key, row]),
    ),
    metrics,
    previous,
    saved,
    slackHumans,
  };

  const profile = buildSlots(PROFILE_SLOTS, profileInput);
  const icp = buildSlots(ICP_SLOTS, profileInput);
  const business_model = buildSlots(BUSINESS_MODEL_SLOTS, profileInput);
  const unrecorded_count = [...profile, ...icp, ...business_model].filter(
    (f) => f.value === null,
  ).length;

  const data: CompanySection = {
    tenant_id,
    name: tenant.display_name || tenant.slug,
    slug: tenant.slug,
    domain: domainFact ?? productUrlHref(tenant.product_url),
    facts,
    description: anchor?.body_markdown ?? null,
    description_updated_at: anchor?.updated_at ?? anchor?.created_at ?? null,
    connected_sources: connected,
    social_profiles,
    profile,
    icp,
    business_model,
    unrecorded_count,
  };

  const hasDescription = Boolean(data.description?.trim());
  const complete = hasDescription && facts.length > 0 && unrecorded_count === 0;
  const anything =
    hasDescription ||
    facts.length > 0 ||
    unrecorded_count < profile.length + icp.length + business_model.length;
  const status = complete ? "ready" : anything ? "partial" : "not_configured";

  const missing: string[] = [];
  if (!hasDescription) missing.push("no company brain note");
  if (facts.length === 0) missing.push("no confirmed company facts");
  if (unrecorded_count > 0) {
    missing.push(
      `${unrecorded_count} profile field${unrecorded_count === 1 ? "" : "s"} with no recorded source`,
    );
  }

  return {
    status,
    detail: complete ? null : `This client has ${missing.join(", ")}.`,
    data,
    source_updated_at: newest,
  };
}

type GoalDbRow = {
  id: string;
  objective: string;
  target_metric: string;
  target_value: number | string;
  baseline_value: number | string | null;
  current_value: number | string | null;
  due_date: string | null;
  status: string;
  priority: number;
  updated_at: string;
  measurement_mode?: string | null;
  count_rule?: unknown;
  value_kind?: string | null;
  value_period_start?: string | null;
};

function toNumber(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function loadGoals(
  tenant_id: string,
  now = new Date(),
): Promise<Section<GoalsSection>> {
  const { data, error } = await sb()
    .from("autopilot_goals")
    .select(
      "id, objective, target_metric, target_value, baseline_value, current_value, current_value_at, due_date, status, priority, created_at, updated_at, measurement_mode, count_rule, value_kind, value_period_start",
    )
    .eq("tenant_id", tenant_id)
    .order("priority", { ascending: false })
    .limit(100);

  if (error) {
    return {
      status: "not_configured",
      detail: `Goals could not be read: ${error.message}`,
      data: {
        goals: [],
        summary: {
          active: 0,
          on_track: 0,
          needs_attention: 0,
          average_progress: null,
        },
      },
      source_updated_at: null,
    };
  }

  const rows = (data ?? []) as unknown as Array<
    GoalDbRow & { created_at: string; current_value_at?: string | null }
  >;
  const today = now.toISOString().slice(0, 10);
  const trajectories = new Map<string, ReturnType<typeof goalTrajectoryView>>();
  let unstated = 0;
  const goals: GoalRow[] = rows.map((row) => {
    const target = toNumber(row.target_value) ?? 0;
    const baseline = toNumber(row.baseline_value);
    const current = toNumber(row.current_value);
    const t = goalTrajectoryView(
      {
        id: row.id,
        target_metric: row.target_metric,
        target_value: target,
        baseline_value: baseline,
        current_value: current,
        current_value_at: row.current_value_at ?? null,
        due_date: row.due_date,
        measurement_mode: row.measurement_mode ?? null,
        created_at: row.created_at,
        count_rule: row.count_rule,
        value_kind: row.value_kind ?? null,
        value_period_start: row.value_period_start ?? null,
      },
      today,
    );
    trajectories.set(row.id, t);
    if (t.kind === "ambiguous" && current != null) unstated++;
    return {
      id: row.id,
      objective: row.objective,
      target_metric: row.target_metric,
      baseline_value: baseline,
      current_value: current,
      target_value: target,
      progress: t.progress,
      due_date: row.due_date,
      status: row.status,
      priority: row.priority,
      updated_at: row.updated_at,
    };
  });

  const active = goals.filter((g) => g.status === "active");
  let onTrack = 0;
  let needsAttention = 0;
  for (const goal of active) {
    const t = trajectories.get(goal.id);
    const pace = goal.status === "met" ? "on_track" : !t || !t.pace_usable ? "unknown" : t.behind_required ? "needs_attention" : t.kind === "ambiguous" ? "unknown" : "on_track";
    if (pace === "on_track") onTrack++;
    else if (pace === "needs_attention") needsAttention++;
  }

  const measurable = goals
    .map((g) => g.progress)
    .filter((p): p is number => p !== null);
  const average =
    measurable.length > 0
      ? measurable.reduce((a, b) => a + b, 0) / measurable.length
      : null;

  const newest =
    goals
      .map((g) => g.updated_at)
      .sort()
      .pop() ?? null;

  return {
    status:
      goals.length === 0
        ? "not_configured"
        : measurable.length === goals.length
          ? "ready"
          : "partial",
    detail:
      goals.length === 0
        ? "This client has no goals set."
        : measurable.length === goals.length
          ? null
          : [
              goals.length - measurable.length - unstated > 0
                ? `${goals.length - measurable.length - unstated} of ${goals.length} goals have no usable current value, so their progress cannot be computed.`
                : null,
              unstated > 0
                ? `${unstated} of ${goals.length} goals have a typed number with no stated way of counting (a running level or this period's total), so no progress is shown until the founder says which.`
                : null,
            ]
              .filter(Boolean)
              .join(" "),
    data: {
      goals,
      summary: {
        active: active.length,
        on_track: onTrack,
        needs_attention: needsAttention,
        average_progress: average,
      },
    },
    source_updated_at: newest,
  };
}

type SnapshotRow = {
  metric_key: string;
  value: number | string | null;
  status: string;
  source: string;
  window_kind: string;
  window_end: string;
};

export async function loadAnalytics(
  tenant_id: string,
  window: { since: string; until: string },
  channels: ChannelsSection | null = null,
): Promise<Section<AnalyticsSection>> {
  const [snapshots, trends] = await Promise.all([
    sb()
      .from("tenant_metric_snapshots")
      .select("metric_key, value, status, source, window_kind, window_end")
      .eq("tenant_id", tenant_id)
      .order("window_end", { ascending: false })
      .limit(500),
    loadTrends(tenant_id, window).catch(() => ({
      points: [],
      channel_points: [],
      sources: [] as string[],
      window,
    })),
  ]);
  const { data, error } = snapshots;

  if (error) {
    return {
      status: "not_connected",
      detail: `Metric snapshots could not be read: ${error.message}`,
      data: { metrics: [], trends, channels },
      source_updated_at: null,
    };
  }

  const latest = new Map<string, SnapshotRow>();
  const previous = new Map<string, SnapshotRow>();
  for (const row of (data ?? []) as SnapshotRow[]) {
    if (!latest.has(row.metric_key)) latest.set(row.metric_key, row);
    else if (!previous.has(row.metric_key)) previous.set(row.metric_key, row);
  }

  const metrics: MetricRow[] = [...latest.entries()].map(([key, row]) => {
    const def = METRIC_REGISTRY[key];
    const value = row.status === "measured" ? toNumber(row.value) : null;
    const prior = previous.get(key);
    const previousValue =
      prior && prior.status === "measured" ? toNumber(prior.value) : null;
    return {
      key,
      label: def?.label ?? key,
      value,
      unit: def?.unit ?? "count",
      direction: def?.direction ?? "context",
      source: row.source,
      window_kind: row.window_kind,
      window_end: row.window_end,
      previous_value: previousValue,
      change:
        value !== null && previousValue !== null && previousValue !== 0
          ? (value - previousValue) / previousValue
          : null,
    };
  });

  metrics.sort((a, b) => a.label.localeCompare(b.label));
  const measured = metrics.filter((m) => m.value !== null).length;
  const newest =
    metrics
      .map((m) => m.window_end)
      .sort()
      .pop() ?? null;

  const gaps: string[] = [];
  if (metrics.length === 0) {
    gaps.push("no KPI snapshots are wired for this client");
  } else if (measured < metrics.length) {
    gaps.push(
      `${metrics.length - measured} metric${metrics.length - measured === 1 ? "" : "s"} could not be measured in the latest window`,
    );
  }
  if (trends.points.length === 0) {
    gaps.push(
      "no connected source reports a daily series, so the trend charts have nothing to draw",
    );
  }

  const hasAnything = metrics.length > 0 || trends.points.length > 0;
  return {
    status: !hasAnything
      ? "not_connected"
      : gaps.length === 0
        ? "ready"
        : "partial",
    detail: gaps.length === 0 ? null : `${gaps.join("; ")}.`,
    data: { metrics, trends, channels },
    source_updated_at: newest,
  };
}

type LooseBlock = {
  type?: unknown;
  rows?: Array<Record<string, unknown>>;
  items?: Array<Record<string, unknown>>;
};

function blocksOf(landscape: unknown): LooseBlock[] {
  if (!landscape || typeof landscape !== "object") return [];
  const blocks = (landscape as { blocks?: unknown }).blocks;
  return Array.isArray(blocks) ? (blocks as LooseBlock[]) : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function loadCompetitors(
  tenant_id: string,
): Promise<Section<CompetitorsSection>> {
  const client = sb();
  const [snapshotResult, profileResult] = await Promise.all([
    client
      .from("competitor_snapshots")
      .select("week_bucket, landscape, created_at")
      .eq("tenant_id", tenant_id)
      .order("week_bucket", { ascending: false })
      .limit(1),
    client
      .from("competitor_profiles")
      .select(
        "website, company_name, industry, positioning, target_audience, pricing, acquisition_channels, threat_level, source_urls, updated_at",
      )
      .eq("tenant_id", tenant_id)
      .order("updated_at", { ascending: false }),
  ]);

  if (snapshotResult.error || profileResult.error) {
    return {
      status: "not_connected",
      detail: `Competitor data could not be read: ${snapshotResult.error?.message ?? profileResult.error?.message}`,
      data: { competitors: [], recommended_moves: [], week_bucket: null },
      source_updated_at: null,
    };
  }

  const snapshot = ((snapshotResult.data ?? [])[0] ?? null) as {
    week_bucket: string;
    landscape: unknown;
    created_at: string;
  } | null;

  type ProfileRow = {
    website: string;
    company_name: string;
    industry: string;
    positioning: string;
    target_audience: string;
    pricing: string;
    acquisition_channels: string[];
    threat_level: string;
    source_urls: unknown;
    updated_at: string;
  };
  const profileRows = (profileResult.data ?? []) as ProfileRow[];
  const competitors: CompetitorRow[] = profileRows.map((row) => ({
    name: row.company_name,
    website: row.website,
    category: row.industry || null,
    positioning: row.positioning || null,
    audience: row.target_audience || null,
    pricing: row.pricing || null,
    channels: Array.isArray(row.acquisition_channels) ? row.acquisition_channels : [],
    strengths: [],
    weaknesses: [],
    threat_level: row.threat_level || null,
    source: "human_reviewed_profile",
    observed_at: row.updated_at,
  }));
  const reviewedNames = new Set(competitors.map((row) => row.name.trim().toLowerCase()));
  const blocks = blocksOf(snapshot?.landscape);
  for (const block of blocks) {
    if (block.type !== "competitive_table" || !Array.isArray(block.rows))
      continue;
    for (const row of block.rows) {
      const name = str(row.brand);
      if (!name) continue;
      if (reviewedNames.has(name.toLowerCase())) continue;
      competitors.push({
        name,
        website: null,
        positioning: str(row.positioning),
        audience: null,
        pricing: str(row.price),
        channels: [],
        strengths: [],
        weaknesses: str(row.gap) ? [str(row.gap) as string] : [],
        threat_level: null,
        source: "competitor_intel_weekly",
        observed_at: snapshot?.created_at ?? null,
      });
    }
  }

  if (competitors.length === 0 && snapshot) {
    for (const name of extractBrands(snapshot.landscape)) {
      competitors.push({
        name,
        website: null,
        positioning: null,
        audience: null,
        pricing: null,
        channels: [],
        strengths: [],
        weaknesses: [],
        threat_level: null,
        source: "competitor_intel_weekly",
        observed_at: snapshot?.created_at ?? null,
      });
    }
  }

  const recommended_moves: Array<{ title: string; rationale: string | null }> =
    [];
  for (const block of blocks) {
    if (block.type === "recommendations" && Array.isArray(block.items)) {
      for (const item of block.items) {
        const title = str(item.title);
        if (title)
          recommended_moves.push({ title, rationale: str(item.body_md) });
      }
    }
    if (block.type === "material_moves" && Array.isArray(block.items)) {
      for (const item of block.items) {
        const move = str(item.move);
        const competitor = str(item.competitor);
        if (move) {
          recommended_moves.push({
            title: competitor ? `${competitor}: ${move}` : move,
            rationale: str(item.why_now),
          });
        }
      }
    }
  }

  const detailed = competitors.filter((c) => c.positioning !== null).length;
  return {
    status:
      competitors.length === 0
        ? "not_configured"
        : detailed === competitors.length
          ? "ready"
          : "partial",
    detail:
      competitors.length === 0
        ? "The latest competitor scan named no competitors."
        : detailed === competitors.length
          ? null
          : `${competitors.length - detailed} competitor${competitors.length - detailed === 1 ? "" : "s"} were named without a positioning summary.`,
    data: { competitors, recommended_moves, week_bucket: snapshot?.week_bucket ?? null },
    source_updated_at:
      profileRows[0]?.updated_at ?? snapshot?.created_at ?? null,
  };
}
