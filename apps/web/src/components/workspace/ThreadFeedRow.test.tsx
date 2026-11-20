
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadFeedRow } from "./ThreadFeedRow";
import {
  feedRowBody,
  groupByDay,
  isThreadInFlight,
  threadLineLabel,
  type ThreadFeedItem,
} from "@/lib/workspace/threadFeedTypes";

vi.mock("./AgentAvatar", () => ({
  AgentAvatar: ({ slug }: { slug: string }) => <span data-agent={slug} />,
}));

function item(partial: Partial<ThreadFeedItem> = {}): ThreadFeedItem {
  return {
    id: "t1",
    title: "Build failure",
    created_at: "2026-07-18T09:00:00.000Z",
    last_message_at: "2026-07-18T10:00:00.000Z",
    last_message: "pushed the fix",
    run_status: "success",
    pending: false,
    reply_count: 4,
    first_user_message: "the build is red on main, can you look",
    presentation_status: "answered",
    ...partial,
  };
}

function html(partial: Partial<ThreadFeedItem> = {}) {
  return renderToStaticMarkup(
    <ThreadFeedRow
      thread={item(partial)}
      agentSlug="engineer"
      agentName="Engineer"
      onOpen={() => {}}
    />,
  );
}

describe("ThreadFeedRow", () => {
  it("renders the first user message as the row body", () => {
    expect(html()).toContain("the build is red on main, can you look");
  });

  it("caps the body at a readable measure", () => {
    expect(html()).toContain("max-w-[78ch]");
  });

  it("renders reply_count verbatim — no second subtraction", () => {
    expect(html({ reply_count: 4 })).toContain("4 replies");
    expect(html({ reply_count: 1 })).toContain("1 reply");
  });

  it("NEVER renders View trace", () => {
    expect(html()).not.toMatch(/view trace/i);
    expect(html({ presentation_status: "running" })).not.toMatch(/view trace/i);
    expect(html({ presentation_status: "failed" })).not.toMatch(/view trace/i);
  });

  it("makes the thread line a real button with a descriptive accessible name", () => {
    const out = html();
    expect(out).toContain("<button");
    expect(out).toContain('aria-label="Open thread with Engineer, 4 replies"');
  });

  it("shows the amber working line instead of the count when in flight", () => {
    const out = html({ presentation_status: "running" });
    expect(out).toContain("Engineer is working…");
    expect(out).not.toContain("4 replies");
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain("Engineer is working on this thread");
  });

  it("shows a last-reply line for a finished thread", () => {
    expect(html()).toContain("Last reply");
  });

  it("omits the thread line entirely when there are no replies and nothing is running", () => {
    const out = html({ reply_count: 0, presentation_status: "answered" });
    expect(out).not.toContain("<button");
    expect(out).not.toContain("0 replies");
  });

  it("renders the reply count as the BLUE link — it is the only thing that navigates", () => {
    const out = html();
    expect(out).toContain("#027bff");
    expect(out).not.toMatch(/font-medium text-ink">\s*4 replies/);
  });

  it("sets the author and the body at the current 14px body size", () => {
    const out = html();
    const author = out.match(/<div class="flex items-baseline gap-2"><span class="([^"]*)">/)?.[1] ?? "";
    const body = out.match(/<p class="([^"]*)">the build is red on main, can you look<\/p>/)?.[1] ?? "";
    expect(author.split(" ")).toContain("text-[14px]");
    expect(body.split(" ")).toContain("text-[14px]");
    expect(author).not.toMatch(/text-\[1[35-9](?:\.\d+)?px\]/);
    expect(body).not.toMatch(/text-\[1[35-9](?:\.\d+)?px\]/);
  });

  it("drops the '·' separator between the count and the last-reply time", () => {
    expect(html()).not.toContain("·");
  });

  it("tints the row and lifts the reply chip on hover", () => {
    const out = html();
    expect(out).toContain("hover:bg-[#f9f9f9]");
    expect(out).toContain("group-hover:bg-white");
    expect(out).toContain("group-hover:border-[#f0f0f0]");
    expect(out).not.toContain("hover:bg-ink/[0.02]");
  });

  it("truncates the body to one line — the feed is for scanning", () => {
    expect(html()).toContain("truncate");
  });

  it("caps the hover card at the design's 567px instead of stretching", () => {
    expect(html()).toContain("max-w-[567px]");
  });

  it("gives the avatar its 40px column", () => {
    expect(html()).toContain("size-10");
  });
});

describe("threadFeedTypes helpers", () => {
  it("isThreadInFlight is true only for running", () => {
    expect(isThreadInFlight(item({ presentation_status: "running" }))).toBe(true);
    expect(isThreadInFlight(item({ presentation_status: "answered" }))).toBe(false);
    expect(isThreadInFlight(item({ presentation_status: null }))).toBe(false);
  });

  it("feedRowBody falls back title → floor, never empty", () => {
    expect(feedRowBody(item({ first_user_message: "hi" }))).toBe("hi");
    expect(feedRowBody(item({ first_user_message: "   ", title: "T" }))).toBe("T");
    expect(feedRowBody(item({ first_user_message: null, title: null }))).toBe(
      "(no message)",
    );
  });

  it("threadLineLabel carries count + agent name, and live state when running", () => {
    expect(threadLineLabel(item({ reply_count: 2 }), "Engineer")).toBe(
      "Open thread with Engineer, 2 replies",
    );
    expect(
      threadLineLabel(item({ presentation_status: "running" }), "Engineer"),
    ).toContain("Engineer is working");
  });

  const atLocal = (day: number, hour: number, minute = 0) =>
    new Date(2026, 6, day, hour, minute).toISOString();

  it("groupByDay groups adjacent rows and preserves server order", () => {
    const rows = [
      item({ id: "a", created_at: atLocal(18, 9) }),
      item({ id: "b", created_at: atLocal(18, 23) }),
      item({ id: "c", created_at: atLocal(17, 9) }),
    ];
    const groups = groupByDay(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0].threads.map((t) => t.id)).toEqual(["a", "b"]);
    expect(groups[1].threads.map((t) => t.id)).toEqual(["c"]);
  });

  it("groupByDay splits on the READER's midnight, not on UTC's", () => {
    const before = new Date(2026, 6, 18, 23, 30);
    const after = new Date(before.getTime() + 60 * 60 * 1000);
    expect(after.getDate()).toBe(19);
    const groups = groupByDay([
      item({ id: "late", created_at: before.toISOString() }),
      item({ id: "past-midnight", created_at: after.toISOString() }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].threads.map((t) => t.id)).toEqual(["late"]);
    expect(groups[1].threads.map((t) => t.id)).toEqual(["past-midnight"]);
  });

  it("groupByDay tolerates rows with no usable timestamp", () => {
    const groups = groupByDay([
      item({ id: "a", created_at: null, last_message_at: null }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].dayIso).toBeNull();
  });
});
