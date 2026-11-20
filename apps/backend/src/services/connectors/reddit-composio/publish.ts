import { composioExecuteTool, type OwnedComposioAccount } from "@/services/connectors/composio/api";
import { composioFailure, composioReceipt, type PublishResult } from "@/services/connectors/composio/publish-receipt";
import { redditParentFullname } from "@/services/connectors/reddit-social/publish";
import { canonicalRedditUrl } from "@/services/channels/reddit/permalink";

const noReceipt = (what: string): PublishResult => ({
  ok: false,
  status: 0,
  raw: { error: `Reddit did not return a ${what} receipt. Check the account before retrying.` },
});

export async function publishRedditSelfPostViaComposio(
  account: OwnedComposioAccount,
  post: { subreddit: string; title: string; text: string },
): Promise<PublishResult> {
  const r = await composioExecuteTool({
    tool_slug: "REDDIT_CREATE_REDDIT_POST",
    user_id: account.tenant_id,
    connected_account_id: account.connected_account_id,
    arguments: { subreddit: post.subreddit, title: post.title, kind: "self", text: post.text, flair_id: "" },
  });
  if (!r.ok) return composioFailure(r, "post failed");
  const { id, record } = composioReceipt(r.data);
  if (!id) return noReceipt("post");
  const url = typeof record.url === "string" && record.url
    ? record.url
    : `https://www.reddit.com/r/${post.subreddit}/comments/${id.replace(/^t3_/, "")}/`;
  return { ok: true, status: 200, raw: { id, url } };
}

export async function publishRedditCommentViaComposio(
  account: OwnedComposioAccount,
  comment: { thread_url: string; text: string },
): Promise<PublishResult> {
  const r = await composioExecuteTool({
    tool_slug: "REDDIT_POST_REDDIT_COMMENT",
    user_id: account.tenant_id,
    connected_account_id: account.connected_account_id,
    arguments: { thing_id: redditParentFullname(comment.thread_url), text: comment.text },
  });
  if (!r.ok) return composioFailure(r, "comment failed");
  const { id } = composioReceipt(r.data);
  if (!id) return noReceipt("comment");
  const threadUrl = canonicalRedditUrl(comment.thread_url);
  return { ok: true, status: 200, raw: { id, url: threadUrl ? `${threadUrl}_/${id.replace(/^t1_/, "")}/` : comment.thread_url } };
}
