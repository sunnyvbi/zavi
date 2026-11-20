import type { DashboardBuilder, DashboardContext } from "./_contract";

type SidecarLite = {
  topics?: unknown;
  message_count?: unknown;
  distinct_user_count?: unknown;
};

const KNOWN_SPECIALISTS = new Set(["dispute-response", "engineer", "verification"]);

const NEXT_STEPS = [
  "auto_resolve",
  "escalate_founder",
  "route_specialist",
  "no_op",
] as const;
type NextStep = (typeof NEXT_STEPS)[number];

const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
type Severity = (typeof SEVERITIES)[number];

type Triage = {
  total_cards: number;
  runs: number;
  funnel: Record<NextStep, number>;
  severity: Record<Severity, number>;
  specialist_routes: { slug: string; count: number }[];
  low_confidence: number;
  last_triage_at: string | null;
};

type CardLite = {
  next_step?: unknown;
  severity?: unknown;
  specialist_slug?: unknown;
  confidence?: unknown;
};

function emptyTriage(): Triage {
  return {
    total_cards: 0,
    runs: 0,
    funnel: {
      auto_resolve: 0,
      escalate_founder: 0,
      route_specialist: 0,
      no_op: 0,
    },
    severity: { P0: 0, P1: 0, P2: 0, P3: 0 },
    specialist_routes: [],
    low_confidence: 0,
    last_triage_at: null,
  };
}

async function readTriage(c: DashboardContext): Promise<Triage | null> {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await c.sb
      .from("agent_runs")
      .select("parsed, finished_at")
      .eq("tenant_id", c.tenantId)
      .eq("agent_slug", "support-lead")
      .eq("status", "success")
      .gte("finished_at", since)
      .order("finished_at", { ascending: false })
      .limit(200);
    if (error) return null;
    const rows = (data ?? []) as {
      parsed: unknown;
      finished_at: string | null;
    }[];

    const t = emptyTriage();
    const routeCounts = new Map<string, number>();
    for (const ns of NEXT_STEPS) t.funnel[ns] = 0;

    for (const row of rows) {
      const parsed = row.parsed;
      if (!parsed || typeof parsed !== "object") continue;
      const cards = (parsed as { cards?: unknown }).cards;
      if (!Array.isArray(cards) || cards.length === 0) continue;

      t.runs += 1;
      if (
        row.finished_at &&
        (t.last_triage_at === null ||
          new Date(row.finished_at).getTime() >
            new Date(t.last_triage_at).getTime())
      ) {
        t.last_triage_at = row.finished_at;
      }

      for (const raw of cards as CardLite[]) {
        if (!raw || typeof raw !== "object") continue;
        t.total_cards += 1;

        const ns = raw.next_step;
        if (typeof ns === "string" && (NEXT_STEPS as readonly string[]).includes(ns)) {
          t.funnel[ns as NextStep] += 1;
        }

        const sev = raw.severity;
        if (
          typeof sev === "string" &&
          (SEVERITIES as readonly string[]).includes(sev)
        ) {
          t.severity[sev as Severity] += 1;
        }

        const conf = Number(raw.confidence);
        if (Number.isFinite(conf) && conf < 0.6) t.low_confidence += 1;

        if (ns === "route_specialist") {
          const slugRaw =
            typeof raw.specialist_slug === "string"
              ? raw.specialist_slug.trim().toLowerCase()
              : "";
          const slug = KNOWN_SPECIALISTS.has(slugRaw) ? slugRaw : "other";
          routeCounts.set(slug, (routeCounts.get(slug) ?? 0) + 1);
        }
      }
    }

    t.specialist_routes = Array.from(routeCounts.entries())
      .map(([slug, count]) => ({ slug, count }))
      .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));

    return t;
  } catch {
    return null;
  }
}

type ChannelRow = {
  channel_id: string;
  name: string;
  member_count: number;
  summary_md: string | null;
  last_summarized_at: string | null;
  join_policy_status: string | null;
  skip_reason: string | null;
  summary_sidecar: SidecarLite | null;
};

type ChannelLite = {
  channel_id: string;
  name: string;
  member_count: number;
  message_count: number;
  distinct_user_count: number;
  topics: string[];
  last_summarized_at: string | null;
};

type AttentionItem = {
  severity: "high" | "warn";
  title: string;
  detail: string;
  ask: string;
};

function toNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") {
      const t = item.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function emptyPulse(
  attention: AttentionItem[] = [],
): Record<string, unknown> {
  return {
    connected: true,
    kpis: {
      channels_summarized: 0,
      message_volume_7d: 0,
      distinct_people: 0,
      oldest_summary_at: null,
    },
    top_themes: [],
    channels: [],
    attention,
  };
}

async function slackConnected(c: DashboardContext): Promise<boolean> {
  try {
    const { data, error } = await c.sb
      .from("connector_metadata")
      .select("slug")
      .eq("tenant_id", c.tenantId)
      .eq("slug", "slack")
      .limit(1);
    if (error) return false;
    return (data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

export const build: DashboardBuilder = async (c) => {
  const triage = await readTriage(c);

  let rows: ChannelRow[] = [];
  try {
    const { data, error } = await c.sb
      .from("slack_channels")
      .select(
        "channel_id, name, member_count, summary_md, last_summarized_at, join_policy_status, skip_reason, summary_sidecar",
      )
      .eq("tenant_id", c.tenantId)
      .order("last_summarized_at", { ascending: false, nullsFirst: false })
      .limit(200);
    if (error) return { connected: false, triage };
    rows = (data ?? []) as ChannelRow[];
  } catch {
    return { connected: false, triage };
  }

  if (rows.length === 0) {
    return (await slackConnected(c))
      ? { ...emptyPulse(), triage }
      : { connected: false, triage };
  }

  const active = rows;

  const attention: AttentionItem[] = [];
  for (const r of active) {
    const failedJoin = r.join_policy_status === "failed";
    const notInChannel = r.skip_reason === "not_in_channel";
    if (failedJoin || notInChannel) {
      attention.push({
        severity: "high",
        title: `Can't triage #${r.name}`,
        detail: failedJoin
          ? `Zavi couldn't join #${r.name}, so it isn't being summarized or triaged.`
          : `Zavi isn't a member of #${r.name}, so it isn't being summarized or triaged.`,
        ask: `Re-invite Zavi to #${r.name} so I can triage it`,
      });
    }
  }

  const summarized: ChannelLite[] = active
    .filter((r) => r.last_summarized_at != null)
    .map((r) => {
      const sc = r.summary_sidecar ?? null;
      return {
        channel_id: r.channel_id,
        name: r.name,
        member_count: toNumber(r.member_count),
        message_count: sc ? toNumber(sc.message_count) : 0,
        distinct_user_count: sc ? toNumber(sc.distinct_user_count) : 0,
        topics: sc ? toStringArray(sc.topics).slice(0, 6) : [],
        last_summarized_at: r.last_summarized_at,
      };
    });

  if (summarized.length === 0) return { ...emptyPulse(attention), triage };

  const channelsSummarized = summarized.length;
  const messageVolume7d = summarized.reduce((s, c2) => s + c2.message_count, 0);
  const distinctPeople = summarized.reduce(
    (s, c2) => s + c2.distinct_user_count,
    0,
  );
  let oldestSummaryAt: string | null = null;
  for (const c2 of summarized) {
    if (!c2.last_summarized_at) continue;
    if (
      oldestSummaryAt === null ||
      new Date(c2.last_summarized_at).getTime() <
        new Date(oldestSummaryAt).getTime()
    ) {
      oldestSummaryAt = c2.last_summarized_at;
    }
  }

  const themeCount = new Map<string, { label: string; count: number }>();
  for (const c2 of summarized) {
    for (const topic of c2.topics) {
      const key = topic.toLowerCase();
      const existing = themeCount.get(key);
      if (existing) existing.count += 1;
      else themeCount.set(key, { label: topic, count: 1 });
    }
  }
  const topThemes = Array.from(themeCount.values())
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 12)
    .map((t) => t.label);

  const channels = [...summarized]
    .sort(
      (a, b) =>
        b.message_count - a.message_count ||
        b.distinct_user_count - a.distinct_user_count,
    )
    .map((c2) => ({
      channel_id: c2.channel_id,
      name: c2.name,
      message_count: c2.message_count,
      distinct_user_count: c2.distinct_user_count,
      member_count: c2.member_count,
      topics: c2.topics.slice(0, 2),
      last_summarized_at: c2.last_summarized_at,
    }))
    .slice(0, 50);

  return {
    connected: true,
    kpis: {
      channels_summarized: channelsSummarized,
      message_volume_7d: messageVolume7d,
      distinct_people: distinctPeople,
      oldest_summary_at: oldestSummaryAt,
    },
    top_themes: topThemes,
    channels,
    attention,
    triage,
  };
};
