import { actionsStoreFor, satisfyingSlugs } from "@zavi/shared";
import type { DashboardBuilder } from "@/routes/agents/dashboards/_contract";
import {
  redditCopyIssue,
  redditPresentationSchema,
  type RedditPresentation,
} from "@/agents/lib/channel-recipe-step";
import {
  readRedditWorkspace,
  type RedditWorkspace,
} from "@/services/channels/reddit/workspace";
import { isOpenAction } from "@/services/channels/rank-actions";
import { REDDIT_CHANNELS, stagedDrafts } from "@/services/channels/staged-drafts";
import { buildRedditInsights } from "@/services/channels/reddit/insights";
import { canonicalRedditUrl, firstRedditThreadUrl } from "@/services/channels/reddit/permalink";
import { ensureBrandKeyword } from "@/services/channels/reddit/suggest";
import { seedCompetitorsFromRecord } from "@/services/channels/reddit/workspace";
import type { RedditInsights } from "@/services/channels/reddit/insights-types";
import { redditDb as serviceClient } from "@/services/channels/reddit/db";
import { getBoolSetting } from "@/services/settings";

export const REDDIT_UNAVAILABLE_METRICS = [
  {
    metric: "impressions",
    reason: "Reddit shows views only to the account that posted, so Zavi does not estimate reach.",
  },
] as const;

const EMPTY_WORKSPACE: RedditWorkspace = { keywords: [], competitors: [], communities: [] };

const REDDIT_CHANNEL_SLUG = "reddit_organic";

type CommunityOverview = {
  name: string;
  reply_opportunities: number;
  post_opportunities: number;
  saved: boolean;
  selected: boolean;
  rules_verdict: "allowed" | "unclear" | "banned" | null;
};

export function buildOverview(
  suggestions: Array<Record<string, unknown>>,
  workspace: RedditWorkspace,
) {
  const byName = new Map<string, CommunityOverview>();
  const key = (n: string) => n.toLowerCase();
  for (const c of workspace.communities) {
    byName.set(key(c.name), {
      name: c.name,
      reply_opportunities: 0,
      post_opportunities: 0,
      saved: true,
      selected: c.selected,
      rules_verdict: c.rules_verdict,
    });
  }
  let replies = 0;
  let posts = 0;
  for (const s of suggestions) {
    const isReply = s.type === "reddit_reply";
    if (isReply) replies++;
    else if (s.type === "reddit_post") posts++;
    const sub = text(s.subreddit)?.replace(/^r\//i, "");
    if (!sub) continue;
    const row =
      byName.get(key(sub)) ??
      {
        name: sub,
        reply_opportunities: 0,
        post_opportunities: 0,
        saved: false,
        selected: false,
        rules_verdict: null,
      };
    if (isReply) row.reply_opportunities++;
    else if (s.type === "reddit_post") row.post_opportunities++;
    byName.set(key(sub), row);
  }
  const busiest = (a: CommunityOverview, b: CommunityOverview) =>
    b.reply_opportunities + b.post_opportunities - (a.reply_opportunities + a.post_opportunities) ||
    Number(b.selected) - Number(a.selected) ||
    a.name.localeCompare(b.name);
  const all = [...byName.values()];
  const saved = all.filter((c) => c.saved);
  const found = all.filter((c) => !c.saved).sort(busiest);
  const communities = [...saved, ...found.slice(0, Math.max(0, 10 - saved.length))].sort(busiest);
  return {
    kpis: {
      reply_opportunities: replies,
      post_opportunities: posts,
      communities: byName.size,
      tracked_keywords: workspace.keywords.filter((k) => k.status === "tracking").length,
      tracked_competitors: workspace.competitors.filter((c) => c.status === "tracking").length,
    },
    top_communities: communities,
    unavailable: REDDIT_UNAVAILABLE_METRICS,
  };
}

type DecisionRow = {
  id: string;
  body: Record<string, unknown> | null;
  emitted_at: string | null;
  agent_run_id: string | null;
  source: "channel_action" | "decision";
};

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function redditPermalink(v: unknown): string | null {
  return canonicalRedditUrl(text(v));
}

function presentation(v: unknown): RedditPresentation | null {
  const result = redditPresentationSchema.safeParse(v);
  if (!result.success) return null;
  const p = result.data;
  const subreddit = p.subreddit.replace(/^r\//i, "");
  const rule_status =
    p.rule_status === "not_allowed" ? "not_allowed" : "verify_manually";

  if (p.type === "reddit_reply") {
    const thread_url = redditPermalink(p.thread_url);
    if (!thread_url) return null;
    return {
      ...p,
      subreddit,
      thread_url,
      rule_status,
    };
  }

  return {
    ...p,
    subreddit,
    rule_status,
  };
}

export const build: DashboardBuilder = async (c) => {
  const redditRunIds = new Set<string>();
  let lastRun: { id: string; status: string | null; enqueued_at: string | null } | null = null;
  try {
    const { data, error } = await c.sb
      .from("agent_runs")
      .select("id, agent_slug, status, enqueued_at")
      .eq("tenant_id", c.tenantId)
      .eq("agent_slug", "reddit_organic")
      .order("enqueued_at", { ascending: false })
      .limit(1);
    if (!error) {
      for (const row of (data ?? []) as Array<{
        id: string;
        status?: string | null;
        enqueued_at?: string | null;
      }>) {
        if (!text(row.id)) continue;
        redditRunIds.add(row.id);
        lastRun = {
          id: row.id,
          status: text(row.status),
          enqueued_at: text(row.enqueued_at),
        };
      }
    }
  } catch {
  }

  const store = actionsStoreFor(REDDIT_CHANNEL_SLUG);
  let decisions: DecisionRow[] = [];
  if (store === "channel_actions") {
    try {
      const { data, error } = await c.sb
        .from("channel_actions")
        .select("id, body, proposed_at, run_id, status, snoozed_until")
        .eq("tenant_id", c.tenantId)
        .eq("channel_slug", REDDIT_CHANNEL_SLUG)
        .in("status", ["pending", "snoozed"])
        .order("proposed_at", { ascending: false })
        .limit(100);
      if (!error && Array.isArray(data)) {
        const now = Date.now();
        decisions = (data as Array<Record<string, unknown>>)
          .filter((row) =>
            isOpenAction(
              {
                status: String(row.status ?? ""),
                snoozed_until: text(row.snoozed_until),
              },
              now,
            ),
          )
          .map((row) => ({
            id: String(row.id),
            body: (row.body ?? null) as Record<string, unknown> | null,
            emitted_at: text(row.proposed_at),
            agent_run_id: text(row.run_id),
            source: "channel_action" as const,
          }));
      }
    } catch {
      decisions = [];
    }
  } else if (redditRunIds.size > 0)
    try {
      const { data, error } = await c.sb
        .from("decisions")
        .select("id, body, emitted_at, agent_run_id")
        .eq("tenant_id", c.tenantId)
        .eq("status", "proposed")
        .eq("decision_class", "channel.recipe_step")
        .in("agent_run_id", [...redditRunIds])
        .order("emitted_at", { ascending: false })
        .limit(100);
      if (!error && Array.isArray(data))
        decisions = (data as Array<Omit<DecisionRow, "source">>).map((row) => ({
          ...row,
          source: "decision" as const,
        }));
    } catch {
      decisions = [];
    }

  const suggestions = [] as Array<Record<string, unknown>>;
  const supporting_steps = [] as Array<Record<string, unknown>>;
  let research_summary: string | null = null;
  for (const decision of decisions) {
    if (
      store !== "channel_actions" &&
      (!decision.agent_run_id || !redditRunIds.has(decision.agent_run_id))
    )
      continue;
    const envelope = decision.body ?? {};
    const step = envelope.step as Record<string, unknown> | undefined;
    const deliverable = step?.deliverable as
      | Record<string, unknown>
      | undefined;
    const view = presentation(deliverable?.presentation);
    const body = text(deliverable?.content);
    if (!research_summary) research_summary = text(envelope.rendered_markdown);
    const evidence = Array.isArray(step?.evidence)
      ? step.evidence
          .map(text)
          .filter((x): x is string => !!x)
          .slice(0, 3)
      : [];
    const stepTitle = text(step?.title);
    const stepBody = text(step?.body);
    const kind = text(deliverable?.kind);
    if (!body) {
      if (stepTitle && stepBody) {
        supporting_steps.push({
          id: decision.id,
          action_source: decision.source,
          title: stepTitle,
          body: stepBody,
          blocking: step?.blocking === true,
          effort: text(step?.effort),
          evidence,
        });
      }
      continue;
    }
    if ((view || kind === "comment") && redditCopyIssue(body)) continue;
    if (!view && kind === "comment") {
      const context = [
        text(step?.title),
        text(step?.body),
        text(deliverable?.label),
        ...evidence,
      ]
        .filter((x): x is string => !!x)
        .join(" ");
      const threadUrl = firstRedditThreadUrl(context);
      const subreddit = context.match(/\br\/([A-Za-z0-9_]+)/)?.[1];
      suggestions.push({
        id: decision.id,
        action_source: decision.source,
        type: "reddit_reply",
        ...(subreddit ? { subreddit } : {}),
        thread_title:
          text(step?.title) ??
          text(deliverable?.label) ??
          "Prepared Reddit answer",
        ...(threadUrl ? { thread_url: threadUrl } : {}),
        reply_style: "Existing Q&A answer",
        rule_status: "verify_manually",
        body,
        emitted_at: decision.emitted_at,
        rationale: text(step?.body),
        evidence,
      });
      continue;
    }
    if (!view) {
      supporting_steps.push({
        id: decision.id,
        action_source: decision.source,
        title: stepTitle ?? text(deliverable?.label) ?? "Reddit follow-up",
        body: stepBody,
        blocking: step?.blocking === true,
        effort: text(step?.effort),
        evidence,
        deliverable: {
          kind: kind ?? "other",
          label: text(deliverable?.label),
          content: body,
        },
      });
      continue;
    }
    suggestions.push({
      id: decision.id,
      action_source: decision.source,
      body,
      emitted_at: decision.emitted_at,
      rationale: text(step?.body),
      evidence,
      ...view,
    });
  }

  let account: { connected: boolean; handle: string | null } = { connected: false, handle: null };
  try {
    const { data } = await c.sb
      .from("connector_metadata")
      .select("slug, team_name")
      .eq("tenant_id", c.tenantId)
      .in("slug", satisfyingSlugs("reddit_social"))
      .limit(2);
    const rows = (data ?? []) as Array<{ slug: string; team_name?: string | null }>;
    const row = rows.find((r) => r.slug === "reddit_social") ?? rows[0];
    if (row) {
      account = {
        connected: true,
        handle: row.slug === "reddit_social" ? (row.team_name ?? null) : null,
      };
    }
  } catch {
  }

  let workspace_v2 = true;
  try {
    workspace_v2 = await getBoolSetting("reddit_workspace_v2", c.tenantId);
  } catch (err) {
    console.error("[reddit-dashboard] flag read failed, allowing", err instanceof Error ? err.message : err);
  }

  let workspace = EMPTY_WORKSPACE;
  let workspace_error: string | null = null;
  let insights: RedditInsights | null = null;
  let insights_error: string | null = null;

  if (workspace_v2) {
    try {
      await ensureBrandKeyword(serviceClient(), c.tenantId);
    } catch (err) {
      console.error("[reddit-dashboard] ensureBrandKeyword failed", err instanceof Error ? err.message : err);
    }

    try {
      await seedCompetitorsFromRecord(serviceClient(), c.tenantId);
    } catch (err) {
      console.error("[reddit-dashboard] competitor seed failed", err instanceof Error ? err.message : err);
    }

    try {
      workspace = await readRedditWorkspace(serviceClient(), c.tenantId);
    } catch (err) {
      console.error("[reddit-dashboard] workspace read failed", err instanceof Error ? err.message : err);
      workspace_error = "Couldn't load your Reddit setup.";
    }

    try {
      insights = await buildRedditInsights(serviceClient(), c.tenantId);
    } catch (err) {
      console.error("[reddit-dashboard] insights failed", err instanceof Error ? err.message : err);
      insights_error = "Couldn't load Reddit insights.";
    }
  }

  const staged = await stagedDrafts(c, REDDIT_CHANNELS);

  return {
    workspace_v2,
    connected: account.connected,
    account,
    manual_publish: false,
    drafts: staged ?? [],
    drafts_ok: staged !== null,
    research_summary,
    suggestions,
    supporting_steps,
    last_run: lastRun,
    workspace,
    workspace_error,
    overview: buildOverview(suggestions, workspace),
    insights,
    insights_error,
  };
};
