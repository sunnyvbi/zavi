"use client";

import { useState } from "react";
import type { RedditPayload } from "./shared";
import { KpiRow, ScanStats, SubredditTable, type Metric } from "./OverviewTab";
import {
  BrandMentionsTable,
  RelevantCommentsTable,
  RelevantPostsTable,
  ReplyOpportunitiesTable,
} from "./KpiTables";

export function RedditAnalyticsTab({
  data,
  onChanged,
}: {
  data: RedditPayload;
  onChanged: () => void;
}) {
  const [metric, setMetric] = useState<Metric>("subreddits");
  const insights = data.insights && data.insights.has_data ? data.insights : null;
  const brandTerms = (data.workspace?.keywords ?? [])
    .filter((k) => k.type === "brand" && k.status === "tracking")
    .map((k) => k.term);

  if (!insights) {
    return (
      <p className="rounded-2xl border border-dashed border-rule bg-cream px-4 py-6 text-center text-[16px] text-inkMuted">
        No Reddit scan yet. Open the Reddit channel and run a scan; the numbers land here.
      </p>
    );
  }

  return (
    <div className="space-y-[18px]">
      <ScanStats insights={insights} />
      <KpiRow insights={insights} selected={metric} onSelect={setMetric} />
      <div
        role="tabpanel"
        id="reddit-analytics-panel"
        aria-label="Details for the selected number"
      >
        {metric === "brand" && (
          <BrandMentionsTable
            lists={insights.lists}
            total={insights.kpis.brand_mentions.value}
            terms={brandTerms}
            onChanged={onChanged}
            connected={data.account?.connected === true}
            communities={[...(data.workspace?.communities ?? []), ...(insights.communities ?? [])]}
          />
        )}
        {metric === "replies" && (
          <ReplyOpportunitiesTable
            opportunities={insights.opportunities}
            total={insights.kpis.reply_opportunities.value}
            threshold={insights.threshold}
            onChanged={onChanged}
          />
        )}
        {metric === "posts" && (
          <RelevantPostsTable
            lists={insights.lists}
            total={insights.kpis.relevant_posts.value}
            scanned={insights.kpis.relevant_posts.scanned}
            threshold={insights.threshold}
          />
        )}
        {metric === "comments" && (
          <RelevantCommentsTable
            lists={insights.lists}
            total={insights.kpis.relevant_comments.value}
            scanned={insights.kpis.relevant_comments.scanned}
            threshold={insights.threshold}
          />
        )}
        {metric === "subreddits" && (
          <SubredditTable data={data} insights={insights} onChanged={onChanged} />
        )}
      </div>
    </div>
  );
}
