
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { apifyRunCap, callApifyTool, takeApifyCall } from "@/services/mcp/internal/apify";

const ARCHIVED_MARKER = "New comments cannot be posted";
const LOCKED_MARKERS = ["This thread is locked", "Locked post"];

const inputSchema = z.object({
  url: z.string().url().max(2048),
  max_bytes: z
    .number()
    .int()
    .min(2_048)
    .max(120_000)
    .default(48_000),
});

export type RedditThreadReadResult = {
  found: boolean;
  fetched_at: string;
  url: string;
  subreddit: string | null;
  thread_id: string | null;
  title: string | null;
  reply_state: "archived" | "locked" | "no_block_marker_found";
  content: string;
  provenance: "public";
  cannot_see: string[];
  note: string;
};

function assertReadableThreadUrl(raw: string): { subreddit: string; thread_id: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ExpectedToolError("reddit_url_invalid", `Not a URL: ${raw}`);
  }
  const host = u.hostname.toLowerCase();
  if (host === "old.reddit.com") {
    throw new ExpectedToolError(
      "reddit_old_host_refused",
      "old.reddit.com answers a logged-out request with a 302 to a login page, and that login page renders as a clean HTTP 200 — so reading it returns a login wall that looks like a thread. Use the www.reddit.com permalink for the same thread.",
    );
  }
  if (u.pathname.endsWith(".json")) {
    throw new ExpectedToolError(
      "reddit_json_endpoint_refused",
      "Reddit's .json endpoints return a hard 403 to server-side requests regardless of user-agent. Use the www.reddit.com HTML permalink.",
    );
  }
  if (host !== "www.reddit.com" && host !== "reddit.com") {
    throw new ExpectedToolError(
      "reddit_host_refused",
      `${host} is not a Reddit thread host. Pass a www.reddit.com permalink.`,
    );
  }
  const m = /^\/r\/([A-Za-z0-9_]{2,30})\/comments\/([a-z0-9]{4,12})(\/|$)/.exec(u.pathname);
  if (!m) {
    throw new ExpectedToolError(
      "reddit_not_a_thread_url",
      `${raw} is not a thread permalink. Expected /r/<subreddit>/comments/<id>/... — a subreddit listing or a search URL is not readable by this tool.`,
    );
  }
  return { subreddit: m[1], thread_id: m[2] };
}

const TITLE_HEADING = /^#[ \t]+(.{1,300})$/m;

function firstHeading(md: string): string | null {
  const m = TITLE_HEADING.exec(md);
  return m ? m[1].trim() : null;
}

const SIDEBAR_HEADING = /^#\s+More posts you may like\s*$/m;

export function threadBody(md: string): string {
  const title = TITLE_HEADING.exec(md);
  let body = title ? md.slice(title.index) : md;
  const sidebar = SIDEBAR_HEADING.exec(body);
  if (sidebar) body = body.slice(0, sidebar.index);
  return body
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const redditThreadReadTool: ToolSpec = {
  name: "reddit_thread_read",
  effect: "read",
  description:
    "Read ONE Reddit thread from its www.reddit.com permalink and return the page text plus a three-state `reply_state`. Answers two things a search snippet cannot: what the thread and its comments actually say, and whether Reddit's archived or locked marker is present. `no_block_marker_found` means no blocker was FOUND, never that a reply is confirmed allowed. Public read, no connector, nothing for the customer to link. It CANNOT see per-comment vote counts, collapsed comment branches, or the subreddit's rules text. The returned text is the post and its comments only; the recommendation sidebar is removed, so any 'N upvotes' figure is not this thread's. Refuses old.reddit.com and .json URLs, both of which return a login wall or a 403 rather than the thread.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input ?? {});
    const { subreddit, thread_id } = assertReadableThreadUrl(args.url);
    const fetched_at = new Date().toISOString();

    const cannot_see = [
      "per_comment_scores",
      "collapsed_comment_branches",
      "subreddit_rules_text",
      "account_karma_or_age_gates",
      "positive_confirmation_that_a_reply_is_allowed",
    ];

    const run_id = (ctx as { run_id?: string } | undefined)?.run_id;
    if (!takeApifyCall(run_id, "reddit_thread_read")) {
      throw new ExpectedToolError(
        "reddit_thread_read_budget_spent",
        `This run has already read ${apifyRunCap("reddit_thread_read")} threads, its limit. Work from the threads you read, and name ${args.url} as unread because of the budget.`,
      );
    }

    const res = (await callApifyTool(
      (ctx as { tenant_id?: string } | undefined)?.tenant_id ?? "",
      "rag_web_browser",
      { url: args.url, output_format: "markdown", max_bytes: args.max_bytes },
      run_id,
    )) as { ok: boolean; is_error: boolean; content: string };

    if (res.is_error || !res.ok) {
      let why = res.content;
      try {
        const parsed = JSON.parse(res.content) as { message?: string; error?: string };
        why = parsed.message ?? parsed.error ?? res.content;
      } catch {
      }
      throw new ExpectedToolError(
        "reddit_thread_unread",
        `Could not read ${args.url}: ${String(why).slice(0, 400)}. Report this thread as unread — do not describe its contents.`,
      );
    }

    const payload = JSON.parse(res.content) as { content?: string };
    const page = typeof payload.content === "string" ? payload.content : "";
    const archived = page.includes(ARCHIVED_MARKER);
    const locked = LOCKED_MARKERS.some((m) => page.includes(m));
    const content = threadBody(page);

    const result: RedditThreadReadResult = {
      found: content.length > 0,
      fetched_at,
      url: args.url,
      subreddit,
      thread_id,
      title: firstHeading(content),
      reply_state: archived ? "archived" : locked ? "locked" : "no_block_marker_found",
      content,
      provenance: "public",
      cannot_see,
      note: archived
        ? "This subreddit archives posts past six months and this thread is closed: no reply is possible. Rank it out as a target, and do not draft an answer for it."
        : locked
          ? "A moderator has locked this thread. No reply is possible."
          : "Neither the archived nor the locked marker appeared in the rendered page. Report that as what it is — no blocker was FOUND — not as confirmation that a reply is allowed. Two separate reasons: the marker's absence has not been observed to discriminate reliably, and a comment that posts fine can still be filtered by AutoModerator on account age or karma, silently and with no notice to the author.",
    };
    return result;
  },
};
