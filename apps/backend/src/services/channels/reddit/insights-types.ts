export type Sentiment = "positive" | "neutral" | "negative";

export type Metric = {
  value: number;
  previous: number | null;
};

export type RedditSweepStatus = {
  id: string;
  status: "running" | "complete" | "partial" | "failed";
  trigger: "cron" | "manual" | "auto";
  started_at: string;
  finished_at: string | null;
  posts_scanned: number;
  comments_scanned: number;
  communities_scanned: number;
  error_code: string | null;
};

export type RedditInsights = {
  has_data: boolean;
  sweep: {
    enabled: boolean;
    last: RedditSweepStatus | null;
    budget: { used_usd_7d: number; cap_usd_7d: number; remaining_usd: number; exhausted: boolean };
    stale: boolean;
  };
  threshold: number;
  today: {
    posts_scanned: number;
    communities_scanned: number;
    posts_relevant: number;
  };
  kpis: {
    brand_mentions: Metric & { brand_terms: number; scanned?: number };
    reply_opportunities: Metric & {
      on_google: { ranked: number; of: number } | null;
    };
    relevant_posts: Metric & { scanned: number };
    relevant_comments: Metric & { scanned: number };
    subreddits: { value: number; top: { name: string; relevance: number } | null };
  };
  communities: Array<{
    name: string;
    relevance: number | null;
    relevance_why: string | null;
    subscribers: number | null;
    posts_per_day: number | null;
    posts_per_day_capped: boolean;
    rules_verdict: "allowed" | "unclear" | "banned" | null;
    selected: boolean;
    saved: boolean;
    recommended: boolean;
    reply_opportunities: number;
  }>;
  opportunities: Array<{
    thread_id: string;
    url: string;
    subreddit: string;
    title: string;
    posted_at: string | null;
    score: number | null;
    comment_count: number | null;
    post_relevance: number;
    comment_relevance: number | null;
    relevance_why: string | null;
    matched_terms: string[];
    google: { checked: boolean; rank: number | null; query: string | null };
    draft: {
      text: string;
      source: "run" | "zavi";
      state: "proposed" | "drafted" | "posted" | "dismissed";
      decision_id: string | null;
      action_source: "decision" | "channel_action" | null;
      rule_status?: "ready" | "verify_manually" | "not_allowed" | null;
    } | null;
  }>;
  keyword_stats: Record<
    string,
    { mentions_7d: number; mentions_prev_7d: number; top_subreddit: string | null; matches_today: number }
  >;
  competitors: Array<{
    id: string | null;
    name: string;
    domain: string | null;
    status?: "tracking" | "paused" | "suggested";
    is_you: boolean;
    mentions_7d: number;
    mentions_prev_7d: number;
    sentiment: { positive: number; neutral: number; negative: number; sample: number } | null;
    top_subreddits: string[];
    latest_thread: { title: string; url: string; subreddit: string; posted_at: string | null; seen_at: string } | null;
  }>;
  lists: {
    brand_mentions: Array<{
      thread_id: string;
      url: string;
      subreddit: string;
      title: string;
      author: string | null;
      term: string;
      sentiment: Sentiment | null;
      score: number | null;
      comment_count: number | null;
      observed_at: string;
      draft?: { text: string | null; state: "drafted" | "posted" | "dismissed" } | null;
    }>;
    relevant_posts: Array<{
      thread_id: string;
      url: string;
      subreddit: string;
      title: string;
      posted_at: string | null;
      relevance: number;
      matched_terms: string[];
      score: number | null;
      comment_count: number | null;
    }>;
    relevant_comments: Array<{
      comment_id: string;
      thread_id: string;
      url: string;
      subreddit: string;
      thread_title: string;
      author: string | null;
      excerpt: string;
      relevance: number;
      matched_terms: string[];
      score: number | null;
    }>;
  };
  share_of_voice: {
    window_days: 7;
    total_mentions: number;
    items: Array<{ name: string; mentions: number; share: number; is_you: boolean }>;
  };
};
