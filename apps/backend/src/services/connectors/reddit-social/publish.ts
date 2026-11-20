
import { SOCIAL_LIMITS } from "@zavi/shared";
import { getConnectorToken } from "@/services/connectors/core/token";
import { REDDIT_SOCIAL_ACCESS_TOKEN_KEY, REDDIT_SOCIAL_SLUG, redditUserAgent } from "./constants";

const SUBMIT_URL = "https://oauth.reddit.com/api/submit";

export type RedditPublishResult = { ok: boolean; status: number; raw: Record<string, unknown> };

type SubmitResponse = {
  json?: {
    errors?: unknown[][];
    data?: { id?: string; name?: string; url?: string; drafts_count?: number };
  };
};

export async function publishRedditSelfPost(
  tenantId: string,
  subreddit: string,
  title: string,
  text: string,
): Promise<RedditPublishResult> {
  const token = await getConnectorToken(tenantId, REDDIT_SOCIAL_SLUG, REDDIT_SOCIAL_ACCESS_TOKEN_KEY);
  if (!token) throw new Error("reddit_social not connected");

  const form = new URLSearchParams({
    api_type: "json",
    sr: subreddit,
    kind: "self",
    title: title.slice(0, 300),
    text,
    sendreplies: "true",
    nsfw: "false",
    spoiler: "false",
  });

  const resp = await fetch(SUBMIT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": redditUserAgent(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(30_000),
  });

  let body: SubmitResponse & Record<string, unknown> = {};
  try {
    body = (await resp.json()) as SubmitResponse & Record<string, unknown>;
  } catch {
    body = { body: await resp.text().catch(() => "") };
  }

  const errors = body.json?.errors ?? [];
  const data = body.json?.data;
  const raw: Record<string, unknown> = { ...body };
  if (data?.id) raw.id = data.id;
  if (data?.name) raw.name = data.name;
  if (data?.url) raw.url = data.url;
  if (errors.length) raw.error = errors.map((e) => (Array.isArray(e) ? e.join(": ") : String(e))).join("; ");

  const ok = resp.ok && errors.length === 0;
  return { ok, status: ok ? resp.status : resp.ok ? 400 : resp.status, raw };
}

export async function isRedditSocialConnected(tenantId: string): Promise<boolean> {
  const token = await getConnectorToken(tenantId, REDDIT_SOCIAL_SLUG, REDDIT_SOCIAL_ACCESS_TOKEN_KEY).catch(() => null);
  return Boolean(token);
}

const COMMENT_URL = "https://oauth.reddit.com/api/comment";

export const REDDIT_COMMENT_MAX_CHARS = SOCIAL_LIMITS.reddit_comment.text;

type CommentResponse = {
  json?: {
    errors?: unknown[][];
    data?: { things?: { data?: { id?: string; name?: string; permalink?: string } }[] };
  };
};

export function redditParentFullname(input: string): string {
  const raw = input.trim();
  if (/^t[13]_[a-z0-9]+$/i.test(raw)) return raw.toLowerCase();

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`reddit parent must be a fullname or a permalink, got: ${raw}`);
  }
  if (!/(^|\.)reddit\.com$/i.test(url.hostname)) {
    throw new Error(`reddit parent permalink must be on reddit.com, got: ${url.hostname}`);
  }
  const seg = url.pathname.split("/").filter(Boolean);
  const at = seg.indexOf("comments");
  const postId = at >= 0 ? seg[at + 1] : undefined;
  if (!postId) throw new Error(`reddit parent permalink has no post id: ${raw}`);
  const commentId = seg[at + 3];
  return commentId ? `t1_${commentId}` : `t3_${postId}`;
}

export async function publishRedditComment(
  tenantId: string,
  parent: string,
  text: string,
): Promise<RedditPublishResult> {
  const token = await getConnectorToken(tenantId, REDDIT_SOCIAL_SLUG, REDDIT_SOCIAL_ACCESS_TOKEN_KEY);
  if (!token) throw new Error("reddit_social not connected");

  if (text.length > REDDIT_COMMENT_MAX_CHARS) {
    throw new Error(`reddit comment is over ${REDDIT_COMMENT_MAX_CHARS} characters (${text.length})`);
  }

  const form = new URLSearchParams({
    api_type: "json",
    thing_id: redditParentFullname(parent),
    text,
  });

  const resp = await fetch(COMMENT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": redditUserAgent(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(30_000),
  });

  let body: CommentResponse & Record<string, unknown> = {};
  try {
    body = (await resp.json()) as CommentResponse & Record<string, unknown>;
  } catch {
    body = { body: await resp.text().catch(() => "") };
  }

  const errors = body.json?.errors ?? [];
  const thing = body.json?.data?.things?.[0]?.data;
  const raw: Record<string, unknown> = { ...body };
  if (thing?.id) raw.id = thing.id;
  if (thing?.name) raw.name = thing.name;
  if (thing?.permalink) raw.url = `https://www.reddit.com${thing.permalink}`;
  if (errors.length) raw.error = errors.map((e) => (Array.isArray(e) ? e.join(": ") : String(e))).join("; ");

  const ok = resp.ok && errors.length === 0;
  return { ok, status: ok ? resp.status : resp.ok ? 400 : resp.status, raw };
}
