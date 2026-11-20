import { tenantClient, asTenantId } from "@/services/tenant-client";

export const MENTION_LOOKBACK_DAYS = 7;
export const MENTION_CANDIDATE_LIMIT = 200;

export type PendingMention = {
  channel: string;
  key: string;
  title: string;
  excerpt: string;
  url: string;
  context: string;
  sentiment: "positive" | "neutral" | "negative" | null;
  observed_at: string;
};

export type MentionProvider = {
  channel: string;
  label: string;
  fetchPending: (tenant_id: string) => Promise<PendingMention[]>;
};

function sinceIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function uniq(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

export async function alreadyAlerted(
  tenant_id: string,
  channel: string,
  keys: string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_mention_alerts_sent")
    .select("mention_key")
    .eq("channel", channel)
    .in("mention_key", keys);
  if (error) throw new Error(`alerted-keys read failed: ${error.message}`);
  return new Set(((data ?? []) as Array<{ mention_key: string }>).map((r) => r.mention_key));
}

type RedditMentionRow = {
  id: string;
  term: string;
  subreddit: string;
  sentiment: "positive" | "neutral" | "negative" | null;
  observed_at: string;
  thread_id: string;
  comment_id: string | null;
};

type RedditThreadRow = { id: string; url: string | null; title: string | null; removed: boolean };
type RedditCommentRow = { id: string; body_excerpt: string | null; author: string | null };

async function readById<T extends { id: string }>(
  tenant_id: string,
  table: string,
  columns: string,
  ids: string[],
): Promise<Map<string, T>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from(table)
    .select(columns)
    .in("id", ids);
  if (error) throw new Error(`${table} read failed: ${error.message}`);
  return new Map(((data ?? []) as unknown as T[]).map((r) => [r.id, r]));
}

export const redditMentionProvider: MentionProvider = {
  channel: "reddit_organic",
  label: "Reddit",
  fetchPending: async (tenant_id) => {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("reddit_mentions")
      .select("id, term, subreddit, sentiment, observed_at, thread_id, comment_id")
      .eq("kind", "brand")
      .gte("observed_at", sinceIso(MENTION_LOOKBACK_DAYS))
      .order("observed_at", { ascending: false })
      .limit(MENTION_CANDIDATE_LIMIT);
    if (error) throw new Error(`reddit mentions read failed: ${error.message}`);

    const rows = (data ?? []) as unknown as RedditMentionRow[];
    const seen = await alreadyAlerted(
      tenant_id,
      "reddit_organic",
      rows.map((r) => r.id),
    );
    const fresh = rows.filter((r) => !seen.has(r.id));
    if (fresh.length === 0) return [];

    const threads = await readById<RedditThreadRow>(
      tenant_id,
      "reddit_threads",
      "id, url, title, removed",
      uniq(fresh.map((r) => r.thread_id)),
    );
    const comments = await readById<RedditCommentRow>(
      tenant_id,
      "reddit_comments",
      "id, body_excerpt, author",
      uniq(fresh.map((r) => r.comment_id)),
    );

    const out: PendingMention[] = [];
    for (const row of fresh) {
      const thread = threads.get(row.thread_id);
      if (!thread || !thread.url || thread.removed) continue;
      const comment = row.comment_id ? (comments.get(row.comment_id) ?? null) : null;
      out.push({
        channel: "reddit_organic",
        key: row.id,
        title: thread.title ?? "",
        excerpt: (comment?.body_excerpt ?? "").trim(),
        url: thread.url,
        context: comment?.author ? `r/${row.subreddit} · u/${comment.author}` : `r/${row.subreddit}`,
        sentiment: row.sentiment,
        observed_at: row.observed_at,
      });
    }
    return out;
  },
};

function noMentionStoreYet(channel: string, label: string): MentionProvider {
  return {
    channel,
    label,
    fetchPending: async () => [],
  };
}

export const MENTION_PROVIDERS: readonly MentionProvider[] = [
  redditMentionProvider,
  noMentionStoreYet("x_organic", "X"),
  noMentionStoreYet("linkedin_organic", "LinkedIn"),
];

export async function collectPendingMentions(
  tenant_id: string,
  providers: readonly MentionProvider[] = MENTION_PROVIDERS,
): Promise<{ mentions: PendingMention[]; failures: Array<{ channel: string; error: string }> }> {
  const mentions: PendingMention[] = [];
  const failures: Array<{ channel: string; error: string }> = [];
  for (const provider of providers) {
    try {
      mentions.push(...(await provider.fetchPending(tenant_id)));
    } catch (e) {
      failures.push({ channel: provider.channel, error: (e as Error).message });
    }
  }
  mentions.sort((a, b) => (a.observed_at < b.observed_at ? 1 : a.observed_at > b.observed_at ? -1 : 0));
  return { mentions, failures };
}
