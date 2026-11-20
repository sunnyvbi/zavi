import { redditStagedCards } from "../../agent/reddit/stagedPosts";
import { REDDIT_METRICS, redditPublishBlocked } from "./_shared";
import type { PlatformSpec, RedditPayload } from "./_shared";
import { COMMUNITY, TOPIC } from "../topActions/fieldSets";

export const reddit_organic: PlatformSpec = {
    name: "Reddit",
    weekCalendar: false,
    railConnect: { toolkit: "reddit", native: "reddit_social", label: "Connect Reddit to post" },
    createMenu: "Create post",
    topActions: [
      {
        key: "find_threads",
        label: "Find threads",
        modal: "scan",
        lead: "Zavi looks through your communities for threads where you can help.",
        note: "This is the same scan as Scan now, with the same weekly limit.",
        primary: "Find threads",
        done: "Looking now. Threads land in What Zavi wants to do.",
      },
      {
        key: "draft_post",
        label: "Draft a post",
        modal: "form",
        lead: "A post for one community that follows its rules.",
        fields: [COMMUNITY, TOPIC],
        primary: "Draft the post",
        done: "Zavi is drafting your post. It lands in What Zavi wants to do.",
        closeOnDone: true,
      },
      {
        key: "add_subreddit",
        label: "Add a subreddit",
        modal: "form",
        submit: "reddit_community",
        lead: "Add a community for Zavi to watch.",
        fields: [{ ...COMMUNITY, name: "name", label: "Subreddit" }],
        primary: "Add",
        done: "Added. Zavi watches it from the next scan.",
      },
    ],
    description: "Finds the right subreddits and publishes posts and replies through your connected account",
    charLimit: 40000,
    extras: ["reddit_kpi_tables"],
    kpiFallback: "reddit",
    metricDisplay: REDDIT_METRICS,
    directPublishOnly: true,
    stagedCards: redditStagedCards,
    scan: {
      endpoint: "/api/reddit/sweep",
      freshnessOf: (payload) => {
        const sweep = (payload as RedditPayload | null)?.insights?.sweep;
        if (!sweep) return null;
        const last = sweep.last ?? null;
        const cleanlyFinishedAt =
          last && (last.status === "complete" || last.status === "partial")
            ? last.finished_at
            : null;
        const t = cleanlyFinishedAt ? Date.parse(cleanlyFinishedAt) : Number.NaN;
        const unreadable = ["all_jobs_failed", "no_jobs_run"];
        const lastFailed =
          last?.status === "failed"
            ? last.error_code === "no_data_returned"
              ? "Last scan read nothing from Reddit. Check your keywords and subreddits, or try again later."
              : unreadable.includes(last.error_code ?? "")
                ? "Last scan failed: Zavi couldn't read Reddit. Try again later."
                : "Last scan failed before it finished. Try again."
            : last?.status === "partial"
              ? "Last scan only partly finished."
              : null;
        return {
          lastAt: cleanlyFinishedAt,
          fresh: !Number.isNaN(t) && Date.now() - t < 86_400_000,
          running: last?.status === "running",
          enabled: sweep.enabled !== false,
          budgetExhausted: sweep.budget?.exhausted === true,
          lastFailed,
        };
      },
    },
    payload: {
      offWhen: (payload) => (payload as RedditPayload | null)?.workspace_v2 === false,
      liveWhen: (payload) =>
        (payload as RedditPayload | null)?.insights?.sweep?.last?.status === "running",
      publishWhen: (payload) => (payload as RedditPayload | null)?.account?.connected === true,
    },
    publish: async (action, content) => {
      const { publishToReddit } = await import("../../agent/reddit/publish");
      return publishToReddit(action, content);
    },
    publishBlocked: redditPublishBlocked,
    settings: [
      {
        kind: "list",
        id: "keywords",
        label: "Keywords",
        help: "Phrases Zavi searches for. The type steers how it reads a thread.",
        itemTypes: [
          "problem",
          "brand",
          "product",
          "competitor",
          "category",
          "comparison",
          "industry",
        ],
        suggest: "/api/reddit/workspace/suggest",
        stats: [
          { key: "mentions_7d", label: "mentions/7d" },
          { key: "top_subreddit", label: "top" },
          { key: "matches_today", label: "today" },
        ],
      },
      {
        kind: "list",
        id: "competitors",
        label: "Competitors",
        help: "Brands Zavi watches for in the same threads, so it can tell you where you are being compared.",
        suggest: "/api/reddit/workspace/suggest",
      },
      {
        kind: "list",
        id: "communities",
        label: "Communities",
        help: "Where Zavi is allowed to look. It will not post anywhere you have not listed.",
        itemTypeOptions: {
          unsetLabel: "Rules: not checked",
          label: (item) => `What the rules of r/${item} say`,
          options: [
            { value: "allowed", label: "Founders may answer, product may be named" },
            { value: "unclear", label: "Unclear, it does not say" },
            { value: "banned", label: "Self-promotion is banned" },
          ],
        },
      },
    ],
  };
