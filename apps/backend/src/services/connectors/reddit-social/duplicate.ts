
import { asTenantId, tenantClient } from "@/services/tenant-client";

export type RedditTwin = { id: string; status: string };

export async function findRedditTwin(
  tenantId: string,
  channel: string,
  payload: Record<string, unknown>,
): Promise<RedditTwin | null> {
  if (channel !== "reddit" && channel !== "reddit_comment") return null;
  const db = tenantClient(asTenantId(tenantId));
  let q = db
    .from("decisions")
    .select("id, status, body")
    .eq("decision_class", "social.publish.v2")
    .eq("body->>channel", channel)
    .in("status", ["proposed", "approved", "dispatching", "acted"]);
  q = channel === "reddit_comment"
    ? q.eq("body->payload->>thread_url", String(payload.thread_url))
    : q.eq("body->payload->>subreddit", String(payload.subreddit)).eq("body->payload->>title", String(payload.title));
  const { data, error } = await q.order("created_at", { ascending: false }).limit(20);
  if (error) throw new Error("reddit_twin_read_failed");
  const rows = (data ?? []) as Array<{ id: string; status: string; body: { payload?: { text?: unknown } } | null }>;
  for (const row of rows) {
    if (row.status === "proposed") {
      if (row.body?.payload?.text === payload.text) return { id: row.id, status: row.status };
      continue;
    }
    if (row.status === "approved" || row.status === "dispatching") return { id: row.id, status: row.status };
    const post = await db.from("social_posts").select("status, last_error").eq("decision_id", row.id).maybeSingle();
    if (post.error) throw new Error("reddit_twin_read_failed");
    const p = post.data as { status: string; last_error: string | null } | null;
    if (!p || (p.status !== "failed" && p.status !== "cancelled")) {
      return { id: row.id, status: row.status };
    }
  }
  return null;
}
