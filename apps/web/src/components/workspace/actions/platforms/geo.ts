
import type { MetricDisplay, PlatformSpec } from "./_shared";
import type { GeoChannelPayload } from "../../geo/types";
import { SHOW_CRAWLER_HITS } from "../../geo/extraTables";
import { Bot, Gauge, ListChecks, MessageSquareQuote, Radio, Sparkles } from "lucide-react";

const GEO_METRICS: Record<string, MetricDisplay> = {
  geo_score: { label: "Readiness", icon: Gauge, selects: "geo_bands" },
  geo_checks: { label: "Checks passed", icon: ListChecks, selects: "geo_checks" },
  geo_mention_rate: { label: "Mentioned", icon: MessageSquareQuote, selects: "geo_mentions" },
  geo_citation_rate: { label: "Cited", icon: MessageSquareQuote, selects: "geo_sources" },
  geo_crawlers: { label: "Crawlers allowed", icon: Radio, selects: "geo_crawlers" },
  ...(SHOW_CRAWLER_HITS ? { geo_hits: { label: "AI crawler hits", icon: Bot, selects: "geo_hits" } } : {}),
  geo_prompts: { label: "Questions tracked", icon: Sparkles, selects: "geo_prompts" },
};

const vis = (payload: unknown) => {
  const v = (payload as GeoChannelPayload | null)?.visibility;
  return v && !(v as { error?: unknown }).error ? (v as Exclude<typeof v, { error: true }>) : null;
};

export const geo: PlatformSpec = {
  name: "GEO",
  description: "Gets your site ready to be quoted in AI answers",
  kpiFallback: "geo",
  analyticsLead: "geo",
  hideStrategyPrompt: true,
  metricDisplay: GEO_METRICS,
  extras: ["geo_tables"],
  metricLayout: { startClosed: true },
  maxWidth: "max-w-[1180px]",
  scan: {
    endpoint: "/api/geo/sweeps",
    freshnessOf: (payload) => {
      const v = vis(payload);
      if (!v) return null;
      const off = v.config.enabled === false;
      const running = v.running != null;
      if (!off && !running && (v.config.configured !== true || !v.config.brand || v.config.prompts_active === 0)) {
        return null;
      }
      const last = v.history.length > 0 ? v.history[v.history.length - 1] : null;
      const finished = last?.finished_at ?? null;
      const t = finished ? Date.parse(finished) : Number.NaN;
      const runCapped = v.config.run_limit_reached === true && !running;
      return {
        lastAt: finished,
        fresh: !Number.isNaN(t) && Date.now() - t < 86_400_000,
        running,
        enabled: !off,
        budgetExhausted: false,
        blockedWhy: runCapped
          ? "This workspace has used all its GEO runs for now."
          : undefined,
      };
    },
  },
  payload: {
    offWhen: (payload) => vis(payload)?.config.enabled === false,
    liveWhen: (payload) => vis(payload)?.running != null,
    seed: {
      endpoint: "/api/geo/prompts/starter",
      emptyWhen: (payload) => {
        const v = vis(payload);
        return (
          !!v &&
          v.config.enabled !== false &&
          v.config.configured === true &&
          !!v.config.brand &&
          (v.config.prompts_active === 0 || v.config.starter_stale === true) &&
          v.config.suggestions_pending === 0
        );
      },
    },
  },

  execCopy: {
    working: "Zavi's engineer is opening the pull request. This can take 10 to 20 minutes.",
    done: "Pull request opened. Review and merge it on GitHub.",
    failedTitle: "No pull request was opened.",
    failedHint: "Nothing in your repository changed. Press Try again.",
    waiting: "Zavi's engineer prepared the pull request. It is waiting for your approval lower on this page; approve it there and it opens.",
    partialTitle: "Zavi will not open another pull request from this card.",
    temporaryHint: "Press Try again to have Zavi prepare it again.",
  },
};
