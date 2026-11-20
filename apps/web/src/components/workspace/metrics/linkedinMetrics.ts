import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";

export const LINKEDIN_METRIC_KEYS = [
  "followers", "total_posts", "engagement_rate", "reactions", "comments", "reposts", "days_since_last_post",
] as const;
export type LinkedInMetricKey = typeof LINKEDIN_METRIC_KEYS[number];

const missing: Record<LinkedInMetricKey, string> = {
  followers: "No follower count collected.",
  total_posts: "No public post data collected.",
  engagement_rate: "Needs post engagement and follower data.",
  reactions: "Reaction counts unavailable.",
  comments: "Comment counts unavailable.",
  reposts: "Repost counts unavailable.",
  days_since_last_post: "Publication date unavailable.",
};

export function linkedinMetricSlots(metrics: readonly ChannelMetric[], payload: unknown): ChannelMetric[] {
  const data = payload && typeof payload === "object" ? payload as {page_url?: unknown; metrics?: unknown} : null;
  const unavailable = !data || !Array.isArray(data.metrics);
  const needsPage = !unavailable && !data?.page_url;
  const byKey = new Map(metrics.map(m => [m.key, m]));
  return LINKEDIN_METRIC_KEYS.map(key => {
    const measured = byKey.get(key);
    if (measured && !measured.unmeasured && Number.isFinite(measured.value)) return measured;
    return {
      key, value: Number.NaN, unit: key === "engagement_rate" ? "pct" : null,
      window_kind: null, day: "", grounded: false, prev_value: null, prev_day: null,
      unmeasured: unavailable ? "LinkedIn data is unavailable. Try Refresh."
        : needsPage ? "Add your LinkedIn page in Settings."
        : typeof measured?.unmeasured === "string" ? measured.unmeasured : missing[key],
    };
  });
}
