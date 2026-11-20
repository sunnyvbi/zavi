import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./AgentAvatar", () => ({
  AgentAvatar: () => null,
}));

import { RunActivityFeed } from "./RunActivityFeed";
import { RunNarrative } from "./RunNarrative";

function activityRow(id: string, body: Record<string, unknown>) {
  return {
    id,
    kind: "chat_activity",
    agent_run_id: "run-1",
    body,
    citations: [],
    created_at: "2026-09-19T00:00:00Z",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const toolRow = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  activityRow(id, { teKind: "tool_call", tool_name: name, ...extra });

describe("RunActivityFeed — queued status copy", () => {
  it("queueAhead > 0 → 'Getting started…', no queue position, never 'working'", () => {
    const html = renderToStaticMarkup(
      <RunActivityFeed rows={[]} agentSlug="pm" queueAhead={3} />,
    );
    expect(html).toContain("Getting started…");
    expect(html).not.toContain("is working");
    expect(html).not.toContain("queued");
    expect(html).not.toContain("ahead");
  });

  it("queueAhead === 0 → 'Getting started…', no 'next up'", () => {
    const html = renderToStaticMarkup(
      <RunActivityFeed rows={[]} agentSlug="pm" queueAhead={0} />,
    );
    expect(html).toContain("Getting started…");
    expect(html).not.toContain("next up");
  });

  it("no queueAhead, nothing emitted yet → agent face + 'Getting started…', not a bare dot", () => {
    const html = renderToStaticMarkup(
      <RunActivityFeed rows={[]} agentSlug="pm" queueAhead={null} />,
    );
    expect(html).toContain("Getting started…");
    expect(html).not.toContain("animate-thinking-dot");
    expect(html).not.toContain("Thinking…");
    expect(html).not.toContain("queued");
  });
});

const DB = "mcp__server__operator_db__query";
const say = (id: string, text: string) => activityRow(id, { teKind: "reasoning", text });
const openCall = (id: string, name: string, target = "{}") =>
  toolRow(id, name, { target, ms: 0, code: "ok", output_preview: "" });
const result = (id: string, name: string, out: string) =>
  toolRow(id, name, { target: "", ms: 0, code: "ok", output_preview: out });

describe("RunActivityFeed — the story", () => {
  const rows = [
    say("r1", "Pulling July live now for a like-for-like comparison."),
    openCall("t1", DB, '{"collection":"trips"}'),
    result("t2", DB, '{"gmv":0}'),
    say("r2", "Hmm, `finalPrice` is returning 0 — let me check the real field names."),
    openCall("t3", DB),
    result("t4", DB, "[elided]"),
    openCall("t5", DB),
  ];
  const html = renderToStaticMarkup(<RunActivityFeed rows={rows} agentSlug="pm" />);

  it("shows the agent's sentences, without code backticks", () => {
    expect(html).toContain("Pulling July live now");
    expect(html).toContain("finalPrice is returning 0");
    expect(html).not.toContain("`");
  });

  it("shows the work in the customer's words: the running step live, the count once it settles", () => {
    expect(html).toContain("Checked your database…");
    const settled = renderToStaticMarkup(
      <RunNarrative rows={[...rows, result("t6", DB, "[elided]")]} agentSlug="pm" state="finished" />,
    );
    expect(settled).toMatch(/Used \d+ tools?/);
    expect(settled).toMatch(/Checked your database<\/span><span[^>]*>2</);
    expect(settled).not.toContain("×");
  });

  it("keeps the raw calls as evidence, read as fields, minus the transport prefix", () => {
    expect(html).toMatch(/>Collection<\/dt><dd[^>]*><span[^>]*>trips</);
    expect(html).toMatch(/>Gmv<\/dt><dd[^>]*><span[^>]*>0</);
    expect(html).not.toContain("&quot;");
    expect(html).not.toContain("mcp__server__");
  });

  it("the story and the raw calls are both folded shut by default", () => {
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });

  it("a failed call is shown and marked, never hidden", () => {
    const failed = renderToStaticMarkup(
      <RunActivityFeed
        rows={[
          openCall("t1", "slack__post_message"),
          toolRow("t2", "slack__post_message", { ms: 0, code: "err", error_message: "channel_not_found" }),
        ]}
        agentSlug="pm"
      />,
    );
    expect(failed).toContain("failed");
    expect(failed).toContain("channel_not_found");
  });

  it("types the live sentence into the panel, with a caret", () => {
    const live = renderToStaticMarkup(
      <RunActivityFeed rows={rows} agentSlug="pm" liveThought="Found it — the price lives und" />,
    );
    expect(live).toContain("Found it — the price lives und");
    expect(live).toContain("animate-pulse");
  });
});

describe("RunActivityFeed — what it still will not show", () => {
  const rows = [
    toolRow("s1", "ToolSearch", { output_preview: '{"type":"tool_reference"}' }),
    openCall("t1", DB),
    result("t2", DB, "x"),
    toolRow("h1", "praxis__handoff", { target: '{"to":"engineer"}', ms: 0, code: "ok", output_preview: "" }),
    say("r1", "**+5.9% MoM** — GMV grew. " + "The interesting part is the mix. ".repeat(20)),
  ];

  it("no final answer, no tool discovery — and a handoff only in the customer's words", () => {
    const html = renderToStaticMarkup(<RunActivityFeed rows={rows} agentSlug="pm" />);
    expect(html).not.toContain("5.9% MoM");
    expect(html).toContain("Brought in a specialist");
    expect(html).not.toMatch(/truncate">\s*handoff/i);
    expect(html).not.toContain("ToolSearch");
    expect(html).not.toContain("tool_reference");
  });

  it("no ETA and no elapsed counter (2026-07-27, still true)", () => {
    const now = new Date().toISOString();
    const html = renderToStaticMarkup(
      <RunActivityFeed rows={rows} agentSlug="pm" startedAt={now} turnStartedAt={now} />,
    );
    expect(html).not.toContain("elapsed");
    expect(html).not.toContain("usually");
    expect(html).not.toMatch(/\(\s*\d/);
  });
});

describe("RunActivityFeed — announced calmly", () => {
  it("exposes a stable sr-only label; the changing summary is aria-hidden", () => {
    const searching = renderToStaticMarkup(
      <RunActivityFeed rows={[toolRow("t1", "web_search__search", { target: "{}", ms: 0, code: "ok", output_preview: "" })]} agentSlug="pm" />,
    );
    const listing = renderToStaticMarkup(
      <RunActivityFeed rows={[toolRow("t1", "meta_ads__list_campaigns", { target: "{}", ms: 0, code: "ok", output_preview: "" })]} agentSlug="pm" />,
    );
    const label = (h: string) => h.match(/class="sr-only">([^<]*)</)?.[1];
    expect(label(searching)).toBe("Product Manager is working");
    expect(label(listing)).toBe("Product Manager is working");
    expect(searching).toMatch(/aria-hidden="true">(<span[^>]*>)?Searched the web…</);
    expect(listing).toMatch(/aria-hidden="true">(<span[^>]*>)?Checked your ads…</);
  });

  it("queued state announces the start-up line, not the queue", () => {
    const html = renderToStaticMarkup(
      <RunActivityFeed rows={[]} agentSlug="pm" queueAhead={3} />,
    );
    expect(html).toMatch(/sr-only[^>]*>Getting started…</);
  });
});

describe("RunActivityFeed — one moving line while it runs", () => {
  it("the in-flight panel is a closed line that shimmers", () => {
    const html = renderToStaticMarkup(
      <RunActivityFeed rows={[toolRow("t1", "web_search__search", { target: "{}" })]} agentSlug="pm" />,
    );
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).toContain("zavi-shimmer");
    expect(html).not.toContain("rounded-[16px] border");
  });

  it("start-up phases read as one 'Getting started…' line, never as steps", () => {
    const html = renderToStaticMarkup(
      <RunActivityFeed
        rows={[activityRow("p1", { teKind: "reasoning", text: "Loading your connected tools" })]}
        agentSlug="pm"
      />,
    );
    expect(html).toContain("Getting started…");
    expect(html).not.toContain("Request received");
    expect(html).not.toContain("<details");
  });
});
