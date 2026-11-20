import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/mcp/internal/apify", () => ({
  callApifyTool: vi.fn(),
  takeApifyCall: vi.fn(() => true),
  apifyRunCap: vi.fn(() => 8),
}));

import { callApifyTool } from "@/services/mcp/internal/apify";
import { redditThreadReadTool, threadBody } from "../thread_read";
import { smartTruncateToolResult, toolResultCapBytes } from "@/services/agents/smart-truncate";

const URL = "https://www.reddit.com/r/webdev/comments/1j3inkp/what_do_yall_use_for_analytics/";

function avatar(user: string): string {
  return `[![u/${user} avatar](https://www.redditstatic.com/avatars/defaults/v2/avatar_default_3.png)](https://www.reddit.com/user/${user}/)`;
}

function comment(user: string, text: string): string {
  return `${avatar(user)}\n\n[${user}](https://www.reddit.com/user/${user}/)\n\n•[](https://www.reddit.com/r/webdev/comments/1j3inkp/comment/x/)\n\n${text}\n\nReply Share\n\n`;
}

function sidebar(): string {
  return (
    "# More posts you may like\n\n" +
    Array.from(
      { length: 60 },
      (_, i) =>
        `![](https://preview.redd.it/p${i}.jpg)\n\n[r/somewhere](https://www.reddit.com/r/somewhere/) • 2y ago\n\n## Unrelated post number ${i}\n\n${900 + i} upvotes · ${40 + i} comments\n\n`,
    ).join("")
  );
}

function renderedPage(banner = ""): string {
  const page =
    "What do yall use for analytics? : r/webdev [Skip to main content](https://www.reddit.com/r/webdev/comments/1j3inkp/#main-content)\n\n" +
    `[\n\n![](https://styles.redditmedia.com/t5_2qs0q/icon.jpg)\n\nGo to webdev](https://www.reddit.com/r/webdev/)\n\n${banner}` +
    "# What do yall use for analytics?\n\nWhat analytics tools are you using?\n\nSort by:\n\nBest\n\n# Comments Section\n\n" +
    Array.from({ length: 14 }, (_, i) =>
      comment(`user${i}`, `Comment ${i}: I have used a privacy-friendly analytics tool for years and it works. `.repeat(4)),
    ).join("") +
    comment("lastuser", "LAST_COMMENT_MARKER I recommend Fathom for this.") +
    sidebar();
  return page + page;
}

beforeEach(() => {
  vi.mocked(callApifyTool).mockReset();
});

describe("threadBody: post and comments only", () => {
  it("starts at the post title and stops before the recommendation sidebar", () => {
    const body = threadBody(renderedPage());
    expect(body.startsWith("# What do yall use for analytics?")).toBe(true);
    expect(body).toContain("LAST_COMMENT_MARKER");
    expect(body).not.toContain("More posts you may like");
    expect(body).not.toMatch(/\d+ upvotes/);
    expect(body).not.toContain("Skip to main content");
  });

  it("drops avatar images but keeps the author name and the comment text", () => {
    const body = threadBody(renderedPage());
    expect(body).not.toContain("avatar_default");
    expect(body).toContain("[user0](https://www.reddit.com/user/user0/)");
    expect(body).toContain("Comment 0: I have used");
  });

  it("keeps the post body when the title is shorter than three characters", async () => {
    const page =
      "AI : r/webdev [Skip to main content](https://www.reddit.com/r/webdev/)\n\n" +
      "# AI\n\nPOST_BODY_MARKER what do you use?\n\n# Comments Section\n\n" +
      comment("user0", "a comment") +
      sidebar();
    expect(threadBody(page).startsWith("# AI")).toBe(true);
    expect(threadBody(page)).toContain("POST_BODY_MARKER");
    vi.mocked(callApifyTool).mockResolvedValue({
      ok: true,
      is_error: false,
      ms: 0,
      content: JSON.stringify({ content: page }),
    });
    const result = (await redditThreadReadTool.execute({ tenant_id: "t" } as never, { url: URL })) as {
      title: string | null;
    };
    expect(result.title).toBe("AI");
  });

  it("returns the text unchanged apart from images when neither heading is present", () => {
    const md = "a page Reddit rendered differently\n\nwith a comment";
    expect(threadBody(md)).toBe(md);
  });
});

describe("reddit_thread_read end to end through the result cap", () => {
  it("reddit readers get their own cap, above the default", () => {
    expect(toolResultCapBytes("reddit", "thread_read")).toBe(24 * 1024);
    expect(toolResultCapBytes("apify", "scrape_reddit")).toBe(24 * 1024);
  });

  it("the model receives the last comment whole", async () => {
    vi.mocked(callApifyTool).mockResolvedValue({
      ok: true,
      is_error: false,
      ms: 0,
      content: JSON.stringify({ content: renderedPage() }),
    });
    const result = await redditThreadReadTool.execute({ tenant_id: "t" } as never, { url: URL });
    const seen = smartTruncateToolResult(JSON.stringify(result), toolResultCapBytes("reddit", "thread_read"));
    expect(seen).toContain("LAST_COMMENT_MARKER");
    expect(JSON.parse(seen)._truncated).toBeUndefined();
  });

  it("keeps the sidebar's vote counts out of what the model sees", async () => {
    vi.mocked(callApifyTool).mockResolvedValue({
      ok: true,
      is_error: false,
      ms: 0,
      content: JSON.stringify({ content: renderedPage() }),
    });
    const result = await redditThreadReadTool.execute({ tenant_id: "t" } as never, { url: URL });
    const seen = smartTruncateToolResult(JSON.stringify(result), toolResultCapBytes("reddit", "thread_read"));
    expect(seen).not.toMatch(/\d+ upvotes/);
  });

  it("without the trim, the same cap hands the model sidebar vote counts (regression anchor)", () => {
    const untrimmed = JSON.stringify({ title: "x", content: renderedPage() });
    const seen = smartTruncateToolResult(untrimmed, toolResultCapBytes("reddit", "thread_read"));
    expect(seen).toMatch(/\d+ upvotes/);
  });

  it("still detects an archived banner rendered above the title, which the trim removes", async () => {
    vi.mocked(callApifyTool).mockResolvedValue({
      ok: true,
      is_error: false,
      ms: 0,
      content: JSON.stringify({ content: renderedPage("Archived post. New comments cannot be posted and votes cannot be cast.\n\n") }),
    });
    const result = (await redditThreadReadTool.execute({ tenant_id: "t" } as never, { url: URL })) as {
      reply_state: string;
      content: string;
    };
    expect(result.reply_state).toBe("archived");
    expect(result.content).not.toContain("New comments cannot be posted");
  });
});
