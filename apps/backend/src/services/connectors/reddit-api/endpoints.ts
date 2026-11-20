import { z } from "zod";
import { redditApiGet } from "./client";

const SUBREDDIT_RE = /^[A-Za-z0-9_]{2,21}$/;
const POST_ID_RE = /^[a-z0-9]{1,12}$/;
const FULLNAME_RE = /^t[1-6]_[a-z0-9]{1,12}$/;

function subredditName(name: string): string {
  const n = name.replace(/^\/?r\//i, "").trim();
  if (!SUBREDDIT_RE.test(n)) throw new Error(`Invalid subreddit name ${JSON.stringify(name)}`);
  return n;
}

const aboutSchema = z.object({
  data: z.object({
    display_name: z.string(),
    subscribers: z.number().nullable().optional(),
    over18: z.boolean().optional(),
    submission_type: z.string().optional(),
    public_description: z.string().optional(),
    subreddit_type: z.string().optional(),
  }),
});

export type SubredditAbout = z.infer<typeof aboutSchema>["data"];

export async function subredditAbout(name: string): Promise<SubredditAbout> {
  const raw = await redditApiGet<unknown>(`/r/${subredditName(name)}/about`);
  return aboutSchema.parse(raw).data;
}

const rulesSchema = z.object({
  rules: z.array(
    z.object({
      short_name: z.string(),
      description: z.string().optional().default(""),
      kind: z.string().optional(),
      priority: z.number().optional(),
    }),
  ),
});

export type SubredditRule = z.infer<typeof rulesSchema>["rules"][number];

export async function subredditRules(name: string): Promise<SubredditRule[]> {
  const raw = await redditApiGet<unknown>(`/r/${subredditName(name)}/about/rules`);
  return rulesSchema.parse(raw).rules;
}

const postSchema = z.object({
  name: z.string(),
  id: z.string(),
  subreddit: z.string(),
  title: z.string(),
  permalink: z.string(),
  created_utc: z.number(),
  score: z.number().optional(),
  num_comments: z.number().optional(),
  locked: z.boolean().optional(),
  archived: z.boolean().optional(),
  removed_by_category: z.string().nullable().optional(),
});

const commentSchema = z.object({
  name: z.string(),
  id: z.string(),
  author: z.string().optional(),
  body: z.string().optional(),
  score: z.number().optional(),
  score_hidden: z.boolean().optional(),
  created_utc: z.number(),
  permalink: z.string().optional(),
});

export type RedditPost = z.infer<typeof postSchema>;
export type RedditComment = z.infer<typeof commentSchema>;

const listing = <T extends z.ZodTypeAny>(child: T) =>
  z.object({
    data: z.object({
      after: z.string().nullable().optional(),
      children: z.array(z.object({ kind: z.string(), data: z.unknown() })),
    }),
  }).transform((l) => ({
    after: l.data.after ?? null,
    items: l.data.children.flatMap((c) => {
      const r = child.safeParse(c.data);
      return r.success ? [r.data as z.infer<T>] : [];
    }),
  }));

export async function searchPosts(opts: {
  q: string;
  subreddit?: string;
  sort?: "relevance" | "new" | "top" | "comments";
  t?: "hour" | "day" | "week" | "month" | "year" | "all";
  limit?: number;
  after?: string;
}): Promise<{ after: string | null; items: RedditPost[] }> {
  const q = opts.q.trim();
  if (!q || q.length > 512) throw new Error("searchPosts: q must be 1..512 chars");
  const path = opts.subreddit ? `/r/${subredditName(opts.subreddit)}/search` : "/search";
  const raw = await redditApiGet<unknown>(path, {
    q,
    type: "link",
    restrict_sr: opts.subreddit ? 1 : undefined,
    sort: opts.sort ?? "new",
    t: opts.t ?? "month",
    limit: Math.min(Math.max(opts.limit ?? 25, 1), 100),
    after: opts.after,
  });
  return listing(postSchema).parse(raw);
}

export async function thread(
  postId: string,
  opts: { limit?: number; sort?: "top" | "new" | "confidence" } = {},
): Promise<{ post: RedditPost; comments: RedditComment[] }> {
  const id = postId.replace(/^t3_/, "");
  if (!POST_ID_RE.test(id)) throw new Error(`Invalid post id ${JSON.stringify(postId)}`);
  const raw = await redditApiGet<unknown>(`/comments/${id}`, {
    sort: opts.sort ?? "top",
    limit: Math.min(Math.max(opts.limit ?? 50, 1), 500),
    depth: 2,
  });
  const parsed = z.tuple([listing(postSchema), listing(commentSchema)]).parse(raw);
  const post = parsed[0].items[0];
  if (!post) throw new Error(`Reddit returned no post for ${id}`);
  return { post, comments: parsed[1].items };
}

export async function info(fullnames: string[]): Promise<Array<RedditPost | RedditComment>> {
  if (fullnames.length === 0) return [];
  if (fullnames.length > 100) throw new Error("info: at most 100 fullnames per call");
  for (const f of fullnames) {
    if (!FULLNAME_RE.test(f)) throw new Error(`Invalid fullname ${JSON.stringify(f)}`);
  }
  const raw = await redditApiGet<unknown>("/api/info", { id: fullnames.join(",") });
  const { items } = listing(z.union([postSchema, commentSchema])).parse(raw);
  return items;
}
