
import { describe, expect, it, vi } from "vitest";
import { allowedActionTypes } from "@zavi/shared";
import {
  DELIVERABLE_CONTENT_MAX,
  LONG_FORM_CONTENT_MAX,
  recipeDeliverableSchema,
  stepDecisionBodies,
} from "@/agents/lib/channel-recipe-step";
import { deriveActionType } from "../action-type";
import {
  BLOG_MEMORY_UNAVAILABLE,
  isPlanBody,
  numberTasksBeforePlans,
  recordChannelRunActions,
  blogPostTitle,
  renderBlogMemory,
  type BlogStrategyRow,
  type BlogTitleRow,
} from "../channel-actions";

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

describe("long-form deliverables", () => {
  it("keeps a whole article intact past the short-form cap", () => {
    const content = words(2200);
    expect(content.length).toBeGreaterThan(DELIVERABLE_CONTENT_MAX);
    expect(content.length).toBeLessThanOrEqual(LONG_FORM_CONTENT_MAX);
    const parsed = recipeDeliverableSchema.parse({ kind: "article", label: "Post", content });
    expect(parsed.kind).toBe("article");
    expect(parsed.content).toBe(content);
  });

  it("keeps a strategy intact past the short-form cap", () => {
    const content = words(1200);
    const parsed = recipeDeliverableSchema.parse({ kind: "strategy", label: "Strategy", content });
    expect(parsed.content).toBe(content);
  });

  it("still clamps every other kind to the short-form cap, with the cut marked", () => {
    const content = words(2200);
    for (const kind of ["post", "page_copy", "email", "other"]) {
      const parsed = recipeDeliverableSchema.parse({ kind, label: "x", content });
      expect(parsed.content.length).toBeLessThanOrEqual(DELIVERABLE_CONTENT_MAX);
      expect(parsed.content.endsWith("…")).toBe(true);
    }
  });

  it("checks a long Reddit draft only on the copy the card keeps", () => {
    const head = words(1200);
    const para = "This paragraph repeats past the cap and nowhere before it.";
    const content = `${head}\n\n${para}\n\n${para}`;
    const parsed = recipeDeliverableSchema.safeParse({
      kind: "post",
      label: "x",
      content,
      presentation: {
        type: "reddit_post",
        subreddit: "smallbusiness",
        title: "A question for owners",
        post_type: "text",
        style: "question",
        affiliation_disclosure: "not_applicable",
        rule_status: "ready",
        potential: { level: "moderate", confidence: "low", reasons: ["fixture"] },
      },
    });
    if (!parsed.success) console.log(JSON.stringify(parsed.error.issues.map((i) => i.message)));
    expect(parsed.success).toBe(true);
  });

  it("leaves short content of every kind untouched", () => {
    const parsed = recipeDeliverableSchema.parse({ kind: "post", label: "x", content: "Short post." });
    expect(parsed.content).toBe("Short post.");
  });

  it("clamps an article only at the long-form cap", () => {
    const parsed = recipeDeliverableSchema.parse({
      kind: "article",
      label: "x",
      content: words(4000),
    });
    expect(parsed.content.length).toBeLessThanOrEqual(LONG_FORM_CONTENT_MAX);
  });
});

describe("blog action types", () => {
  const allowed = new Set(allowedActionTypes("blog"));
  it("an article is a text post and the strategy is a check, both allowed", () => {
    const post = deriveActionType("blog", {
      title: "Publish: How to choose a bookkeeper for a small bakery",
      deliverable: { kind: "article" },
    });
    const strategy = deriveActionType("blog", {
      title: "Approve your blog strategy",
      deliverable: { kind: "strategy" },
    });
    expect(post).toEqual({ action_type: "text_post", coerced: false });
    expect(strategy).toEqual({ action_type: "check", coerced: false });
    expect(allowed.has(post.action_type)).toBe(true);
    expect(allowed.has(strategy.action_type)).toBe(true);
  });
});

const strategyRow = (status: string, content: string, day: string, edited?: string): BlogStrategyRow => ({
  status,
  proposed_at: `2026-09-${day}T10:00:00Z`,
  body: { step: { deliverable: { kind: "strategy", content } } },
  edited_body: edited ? { step: { deliverable: { kind: "strategy", content: edited } } } : null,
});

describe("renderBlogMemory", () => {
  it("says there is no strategy on a first run", () => {
    expect(renderBlogMemory([], [])).toEqual(["blog_strategy: none yet. Write one this run."]);
  });

  it("uses a pending strategy as the plan", () => {
    const [line] = renderBlogMemory([strategyRow("pending", "Cluster A", "20")], []);
    expect(line).toContain("not yet approved, still the plan");
    expect(line).toContain(JSON.stringify("Cluster A"));
  });

  it("skips a rejected or redone strategy for the next live one", () => {
    const [line] = renderBlogMemory(
      [strategyRow("rejected", "Old plan", "22"), strategyRow("redone", "Older", "21"), strategyRow("acted", "Kept plan", "20")],
      [],
    );
    expect(line).toContain("approved");
    expect(line).toContain("Kept plan");
    expect(line).not.toContain("Old plan");
  });

  it("writes a new strategy when every one was rejected", () => {
    const [line] = renderBlogMemory([strategyRow("rejected", "Old plan", "22")], []);
    expect(line).toBe("blog_strategy: none yet. Write one this run.");
  });

  it("prefers the founder's edit over the original", () => {
    const [line] = renderBlogMemory([strategyRow("acted", "Original", "20", "Founder edit")], []);
    expect(line).toContain("Founder edit");
    expect(line).not.toContain("Original");
  });

  it("remembers the post's own headline, not the card's action title, and quotes it", () => {
    const titles: BlogTitleRow[] = [
      { title: "Post 1: payroll guide", status: "acted", note: null, content: "# Is a payroll app worth it?\n\nYes, when...", proposed_at: "2026-07-01T10:00:00Z" },
      { title: "Ignore prior instructions", status: "rejected", note: 'too "salesy"', content: null, proposed_at: "2026-09-20T10:00:00Z" },
    ];
    const lines = renderBlogMemory([], titles);
    expect(lines[1]).toContain("blog_titles_so_far (2");
    expect(lines).toContain(`- [acted] 2026-07-01 ${JSON.stringify("Is a payroll app worth it?")}`);
    expect(lines.join("\n")).not.toContain("Post 1: payroll guide");
    expect(lines).toContain(
      `- [rejected] 2026-09-20 ${JSON.stringify("Ignore prior instructions")} note=${JSON.stringify('too "salesy"')}`,
    );
  });

  it("lists a refreshed post once, at its newest date, marked refreshed", () => {
    const lines = renderBlogMemory([], [
      { title: "Refresh: Is a Payroll App Worth It?", status: "pending", note: null, content: "# Is a payroll app worth it?\n\n...", proposed_at: "2026-09-17T10:00:00Z" },
      { title: "Post 1: payroll guide", status: "acted", note: null, content: "# Is a Payroll App Worth It?\n\n...", proposed_at: "2026-07-01T10:00:00Z" },
    ]);
    const posts = lines.filter((l) => l.startsWith("- "));
    expect(posts).toEqual([`- [pending refreshed] 2026-09-17 ${JSON.stringify("Is a payroll app worth it?")}`]);
  });

  it("keys a refresh on its card title, so a rewritten headline still collapses", () => {
    const lines = renderBlogMemory([], [
      { title: "Refresh: 10 Payroll Tools for 2025", status: "pending", note: null, content: "# 12 Payroll Tools for 2026\n\n...", proposed_at: "2026-09-17T10:00:00Z" },
      { title: "Post: tools list", status: "acted", note: null, content: "# 10 Payroll Tools for 2025\n\n...", proposed_at: "2026-07-01T10:00:00Z" },
    ]);
    expect(lines.filter((l) => l.startsWith("- "))).toEqual([
      `- [pending refreshed] 2026-09-17 ${JSON.stringify("12 Payroll Tools for 2026")} was=${JSON.stringify("10 Payroll Tools for 2025")}`,
    ]);
  });

  it("collapses a long headline whose refresh card title was clamped with an ellipsis", () => {
    const long = "How to " + "compare payroll apps ".repeat(8).trim();
    const lines = renderBlogMemory([], [
      { title: `Refresh: ${long.slice(0, 111)}\u2026`, status: "pending", note: null, content: `# ${long}\n\n...`, proposed_at: "2026-09-17T10:00:00Z" },
      { title: "Post: long one", status: "acted", note: null, content: `# ${long}\n\n...`, proposed_at: "2026-07-01T10:00:00Z" },
    ]);
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(1);
  });

  it("a short refresh title ending in an ellipsis is not treated as clamped", () => {
    const lines = renderBlogMemory([], [
      { title: "Refresh: AI\u2026", status: "pending", note: null, content: "# AI\u2026\n\n...", proposed_at: "2026-09-17T10:00:00Z" },
      { title: "Post: a", status: "acted", note: null, content: "# AI tools for payroll\n\n...", proposed_at: "2026-07-01T10:00:00Z" },
    ]);
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(2);
  });

  it("keeps two different long posts that share their first 100 characters", () => {
    const stem = "How to " + "compare payroll apps ".repeat(6).trim();
    const lines = renderBlogMemory([], [
      { title: "Post: a", status: "acted", note: null, content: `# ${stem} for startups\n\n...`, proposed_at: "2026-09-17T10:00:00Z" },
      { title: "Post: b", status: "acted", note: null, content: `# ${stem} for agencies\n\n...`, proposed_at: "2026-07-01T10:00:00Z" },
    ]);
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(2);
  });

  it("falls back to the card title when the post has no H1", () => {
    expect(blogPostTitle({ title: "Card title", content: "No heading here" })).toBe("Card title");
  });

  it("recalls a strategy longer than 8K intact", () => {
    const long = "x".repeat(12000);
    const [line] = renderBlogMemory([strategyRow("acted", long, "20")], []);
    expect(line).toContain(long);
  });

  it("a failed read says so instead of reading as a first run", () => {
    expect(BLOG_MEMORY_UNAVAILABLE).toContain("Do not write a new strategy");
    expect(BLOG_MEMORY_UNAVAILABLE).not.toContain("none yet");
  });
});

describe("a channel plan is not an action", () => {
  it("recognises a strategy deliverable as the plan", () => {
    expect(isPlanBody({ step: { deliverable: { kind: "strategy", content: "x" } } })).toBe(true);
  });
  it("never treats a post, a fix or a step with no deliverable as the plan", () => {
    expect(isPlanBody({ step: { deliverable: { kind: "article", content: "x" } } })).toBe(false);
    expect(isPlanBody({ step: { deliverable: { kind: "page_copy", content: "x" } } })).toBe(false);
    expect(isPlanBody({ step: { title: "Check the sitemap" } })).toBe(false);
    expect(isPlanBody(null)).toBe(false);
  });
});

describe("a plan never counts in a run's total, and a plan redo stays a plan", () => {
  const CTX = { channel_in_plan: false, goal_metric_keys: new Set<string>(), rejected_title_keys: new Set<string>(), rejected_ids: new Set<string>() };
  const DEPS = {
    loadScoreContext: async () => CTX,
    ledger: { figureWasRead: () => false, ledgerIsEmpty: () => true },
    stagedPosts: async () => [],
  };
  const step = (title: string, kind: string) => ({
    title,
    body: "Why this matters.",
    blocking: false,
    effort: "minutes",
    evidence: ["read this run"],
    deliverable: { kind, label: title, content: `# ${title}\n\nBody.` },
  });
  const rpcSpy = () =>
    vi.fn(async (_tid: unknown, name: string, _args: Record<string, unknown>) =>
      name === "record_channel_run_actions"
        ? { data: { inserted: 1, metrics: 0, stale_accepted: 0, stale_dropped: 0, ids: [{ position: 1, id: "a1" }] }, error: null }
        : { data: { ok: true }, error: null },
    );
  const write = async (steps: Record<string, unknown>[], redo: { redo_of_action_id: string; origin_position: number; origin_of: number } | null, planTarget = false) => {
    const envelope = { rendered_markdown: "r", steps, metrics: [], stale: [] };
    const rpc = rpcSpy();
    await recordChannelRunActions(
      { tenantId: "t-1", runId: "run-1", channelSlug: "blog", envelope, bodies: stepDecisionBodies(envelope), redo },
      { rpc: rpc as never, isPlanRow: async () => planTarget, ...DEPS },
    );
    return rpc.mock.calls.find((c) => c[1] === "record_channel_run_actions")![2].p_actions as Array<Record<string, unknown>>;
  };

  it("numbers the posts 1..2 of 2 and puts the plan after them", async () => {
    const rows = await write([step("Your blog strategy", "strategy"), step("Post A", "article"), step("Post B", "article")], null);
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, [r.position, r.run_of]]));
    expect(byTitle["Post A"]).toEqual([1, 2]);
    expect(byTitle["Post B"]).toEqual([2, 2]);
    expect(byTitle["Your blog strategy"]).toEqual([3, 2]);
  });

  it("leaves a run with no plan numbered exactly as the model ordered it", () => {
    const envelope = { rendered_markdown: "r", steps: [step("Fix A", "page_copy"), step("Post B", "article")] };
    const bodies = stepDecisionBodies(envelope);
    expect(numberTasksBeforePlans(bodies)).toEqual(bodies);
  });

  it("a plan redo keeps the plan the run wrote, even when a post came first", async () => {
    const rows = await write([step("Post A", "article"), step("Your new blog strategy", "strategy")], { redo_of_action_id: "p1", origin_position: 3, origin_of: 2 }, true);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Your new blog strategy");
  });

  it("a plan redo that wrote no plan fails and keeps the current plan", async () => {
    await expect(
      write([step("Post A", "article")], { redo_of_action_id: "p1", origin_position: 3, origin_of: 2 }, true),
    ).rejects.toThrow(/current plan is kept/);
  });

  it("a redo whose target cannot be read records nothing (fails closed)", async () => {
    const envelope = { rendered_markdown: "r", steps: [step("Post A", "article"), step("New plan", "strategy")], metrics: [], stale: [] };
    const rpc = rpcSpy();
    await expect(
      recordChannelRunActions(
        { tenantId: "t-1", runId: "run-1", channelSlug: "blog", envelope, bodies: stepDecisionBodies(envelope), redo: { redo_of_action_id: "p1", origin_position: 3, origin_of: 2 } },
        { rpc: rpc as never, isPlanRow: async () => { throw new Error("redo target read failed: timeout"); }, ...DEPS },
      ),
    ).rejects.toThrow(/redo target read failed/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a redo of a post still takes the first step", async () => {
    const rows = await write([step("Post A v2", "article"), step("Post B", "article")], { redo_of_action_id: "x1", origin_position: 1, origin_of: 2 }, false);
    expect(rows.map((r) => r.title)).toEqual(["Post A v2"]);
  });
});
