import { beforeEach, describe, expect, it, vi } from "vitest";

const saved: Array<{ run_id: string; seq: number; block: Record<string, unknown> }> = [];
let failSave = false;
vi.mock("@/services/copilotkit/mcp-ui-tools", () => ({
  saveUiBlockArtifact: vi.fn(async (ctx: { run_id: string }, seq: number, block: Record<string, unknown>) => {
    if (failSave) throw new Error("storage down");
    saved.push({ run_id: ctx.run_id, seq, block });
    return `art-${seq}`;
  }),
  shownRowsOf: () => [],
}));

import { recordFigures, clearFigures } from "@/services/agents/engine/figure-ledger";
import { cardToText, newReplyCardsState, settleReplyCards } from "../reply-cards";

const RUN = "run-cards-test";
const ctx = { tenant_id: "t-1", run_id: RUN, agent_slug: "operator" };
const block = (o: unknown) => `<zavi-ui>${JSON.stringify(o)}</zavi-ui>`;

beforeEach(() => {
  saved.length = 0;
  failSave = false;
  clearFigures(RUN);
});

describe("settleReplyCards", () => {
  it("stores the card from the Atlanta ads answer (audit row 8) and strips it from the text", async () => {
    recordFigures(RUN, JSON.stringify({ meta: { spend: 40.84, clicks: 986 }, google: { spend: 32.97, clicks: 249 } }));
    const text =
      "**Not yet. Meta and Google are getting clicks in Atlanta, neither has a booking.**\n\n" +
      block({
        kind: "table",
        title: "Atlanta ads, first day",
        columns: ["Channel", "Spend", "Clicks", "Bookings"],
        rows: [["Meta", "$40.84", 986, 0], ["Google", "$32.97", 249, 0], ["TikTok", "not running", null, null]],
      }) +
      "\n\n**Recommended next action:** re-check on Oct 17.";
    const r = await settleReplyCards(text, ctx, { save: true });
    expect(saved).toHaveLength(1);
    expect(saved[0].block.kind).toBe("table");
    expect(r.text).not.toContain("<zavi-ui");
    expect(r.text).toContain("Recommended next action");
    expect(r.stats).toEqual({ found: 1, saved: 1, as_text: 0, invalid: 0 });
  });

  it("unwraps a card the model put in a code fence, leaving no empty fence", async () => {
    const card = block({ kind: "table", title: "Atlanta bookings by week", columns: ["Week", "Bookings"], rows: [["Oct 5 to Oct 11", 2]] });
    for (const fence of ["```zavi-ui", "```json", "```"]) {
      saved.length = 0;
      const text = `Atlanta was flat.\n\n${fence}\n${card}\n\`\`\`\n\n- **Last week:** both cancelled.`;
      const r = await settleReplyCards(text, ctx, { save: true, state: newReplyCardsState() });
      expect(saved).toHaveLength(1);
      expect(r.text).not.toContain("```");
      expect(r.text).toContain("Atlanta was flat.");
      expect(r.text).toContain("- **Last week:** both cancelled.");
    }
  });

  it("leaves a fence that holds real code alongside a card's text alone", async () => {
    const text = "Run this:\n\n```sql\nselect 1;\n```";
    const r = await settleReplyCards(text, ctx, { save: true });
    expect(r.text).toBe(text);
  });

  it("marks a kpi verified only when every number was read this run, never from the model", async () => {
    recordFigures(RUN, JSON.stringify({ bookings: 56, gmv: 1412 }));
    await settleReplyCards(
      block({ kind: "kpi", title: "Last week", verified: true, items: [{ label: "Bookings", value: 56 }, { label: "GMV", value: "$1,412" }] }),
      ctx,
      { save: true },
    );
    expect(saved[0].block.verified).toBe(true);
    expect((saved[0].block.items as Array<{ verified?: boolean }>).map((i) => i.verified)).toEqual([true, true]);
    saved.length = 0;
    await settleReplyCards(
      block({ kind: "kpi", title: "Made up", verified: true, items: [{ label: "Bookings", value: 999 }] }),
      ctx,
      { save: true },
    );
    expect(saved[0].block.verified).toBe(false);
  });

  it("drops server-owned receipt fields the model wrote", async () => {
    await settleReplyCards(
      block({ kind: "chart", title: "Spend", receipt: { source: "stripe" }, result_id: "r1", series: [{ label: "Mon", value: 12 }] }),
      ctx,
      { save: true },
    );
    expect(saved[0].block.receipt).toBeUndefined();
    expect(saved[0].block.result_id).toBeUndefined();
  });

  it("never shows raw JSON: bad JSON is removed, a schema miss becomes text", async () => {
    const bad = await settleReplyCards("Answer.\n\n<zavi-ui>{not json</zavi-ui>", ctx, { save: true });
    expect(bad.text).toBe("Answer.");
    expect(bad.stats.invalid).toBe(1);
    const miss = await settleReplyCards(
      "Answer.\n\n" + block({ kind: "table", title: "Hosts owed", columns: [], rows: [["Ana", "$120"]] }),
      ctx,
      { save: true },
    );
    expect(saved).toHaveLength(0);
    expect(miss.text).toContain("**Hosts owed**");
    expect(miss.text).not.toMatch(/[{}]/);
  });

  it("stores at most 2 cards; the rest become text", async () => {
    const k = (t: string) => block({ kind: "kpi", title: t, items: [{ label: "A", value: 1 }] });
    const r = await settleReplyCards(`x ${k("One")} ${k("Two")} ${k("Three")}`, ctx, { save: true });
    expect(saved.map((s) => s.block.title)).toEqual(["One", "Two"]);
    expect(r.text).toContain("**Three**");
    expect(r.stats).toMatchObject({ found: 3, saved: 2, as_text: 1 });
  });

  it("text surfaces get a readable table, not a card", async () => {
    const r = await settleReplyCards(
      block({ kind: "table", title: "Status", columns: ["Item", "State"], rows: [["Payout A", "stuck"]] }),
      ctx,
      { save: false },
    );
    expect(saved).toHaveLength(0);
    expect(r.text).toContain("| Item | State |");
    expect(r.text).toContain("| Payout A | stuck |");
  });

  it("keeps the card as text when storing it fails", async () => {
    failSave = true;
    const r = await settleReplyCards(block({ kind: "kpi", title: "Spend", items: [{ label: "Meta", value: "$41" }] }), ctx, { save: true });
    expect(r.text).toContain("- Meta: $41");
  });

  it("dedupes the same block across the output and the summary of one run", async () => {
    const b = block({ kind: "kpi", title: "Spend", items: [{ label: "Meta", value: 41 }] });
    const state = newReplyCardsState();
    await settleReplyCards(`a ${b}`, ctx, { save: true, state });
    const second = await settleReplyCards(`b ${b}`, ctx, { save: true, state });
    expect(saved).toHaveLength(1);
    expect(second.text).toBe("b");
  });

  it("removes an unclosed block left by a cut-off reply", async () => {
    const r = await settleReplyCards('Answer.\n\n<zavi-ui>{"kind":"table","title":"cut', ctx, { save: true });
    expect(r.text).toBe("Answer.");
  });

  it("refuses an html card that would render blank and keeps its text", async () => {
    const r = await settleReplyCards(
      block({ kind: "html", title: "Plan", html: "<div><canvas id=\"c\"></canvas><script>draw()</script></div>" }),
      ctx,
      { save: true },
    );
    expect(saved).toHaveLength(0);
    expect(r.text).toContain("**Plan**");
  });

  it("drops a block that hides text behind JSON escapes the scrub never saw", async () => {
    const r = await settleReplyCards(
      'Here.\n\n<zavi-ui>{"kind":"table","title":"Owed","columns":["Host"],"rows":[["ana\\u0040example.com"]]}</zavi-ui>',
      ctx,
      { save: true },
    );
    expect(saved).toHaveLength(0);
    expect(r.text).toBe("Here.");
  });

  it("never turns scripts on for a model-written html card", async () => {
    await settleReplyCards(block({ kind: "html", title: "Plan", scripts: true, html: "<div><p>Week 1: fix WhatsApp</p></div>" }), ctx, { save: true });
    expect(saved[0].block.scripts).toBeUndefined();
  });

  it("marks the one tile whose delta was never read", async () => {
    recordFigures(RUN, JSON.stringify({ bookings: 56 }));
    await settleReplyCards(
      block({ kind: "kpi", title: "Week", items: [{ label: "Bookings", value: 56, delta: "+37% vs last week" }, { label: "Cars", value: 56 }] }),
      ctx,
      { save: true },
    );
    expect((saved[0].block.items as Array<{ verified?: boolean }>).map((i) => i.verified)).toEqual([false, true]);
    expect(saved[0].block.verified).toBe(false);
  });

  it("gives distinct cards in the output and the summary their own slots", async () => {
    const state = newReplyCardsState();
    const k = (t: string) => block({ kind: "kpi", title: t, items: [{ label: "A", value: 1 }] });
    await settleReplyCards(`out ${k("A")}`, ctx, { save: true, state });
    await settleReplyCards(`sum ${k("B")}`, ctx, { save: true, state });
    expect(saved.map((x) => x.seq)).toEqual([300, 301]);
  });

  it("refuses an html card with character references the scrub never decoded", async () => {
    const r = await settleReplyCards("x " + block({ kind: "html", title: "Hosts", html: "<p>ana&#64;example.com</p>" }), ctx, { save: true });
    expect(saved).toHaveLength(0);
    expect(r.text).toBe("x");
  });

  it("does not verify a tile on a one-digit delta nobody read", async () => {
    recordFigures(RUN, JSON.stringify({ bookings: 56 }));
    await settleReplyCards(block({ kind: "kpi", title: "W", items: [{ label: "Bookings", value: 56, delta: "+9% vs last week" }] }), ctx, { save: true });
    expect((saved[0].block.items as Array<{ verified?: boolean }>)[0].verified).toBe(false);
  });

  it("drops a broken block carrying character references instead of showing its text", async () => {
    const r = await settleReplyCards('x <zavi-ui>{"kind":"html","title":"Contacts","html":"alice&commat;example.com","height":"400"}</zavi-ui>', ctx, { save: true });
    expect(r.text).toBe("x");
  });

  it("checks a chart's goal line too", async () => {
    recordFigures(RUN, JSON.stringify({ a: 100, b: 200 }));
    await settleReplyCards(block({ kind: "chart", title: "Spend", goal: 5000, series: [{ label: "A", value: 100 }, { label: "B", value: 200 }] }), ctx, { save: true });
    expect(saved[0].block.verified).toBe(false);
  });

  it.each(["alice@example&period;com", "ana&#x40;x.com", "a&commat;b.com", "alice&nbsp;[at]&nbsp;example&nbsp;[dot]&nbsp;com"])("drops a block with the character reference in %s", async (v) => {
    const r = await settleReplyCards("x " + block({ kind: "posts", title: "T", posts: [{ channel: "x", payload: { text: v } }] }), ctx, { save: true });
    expect(saved).toHaveLength(0);
    expect(r.text).toBe("x");
  });

  it("drops a card with a quoted address spelled with &quot;", async () => {
    const r = await settleReplyCards("x " + block({ kind: "html", title: "C", html: "<p>&quot;alice&quot;@customer.com</p>" }), ctx, { save: true });
    expect(saved).toHaveLength(0);
    expect(r.text).toBe("x");
  });

  it("sends an html card with a semicolonless reference to its text version", async () => {
    const r = await settleReplyCards(
      block({ kind: "html", title: "Contact", html: "<p>alice&nbsp [at]&nbsp example&nbsp [dot]&nbsp com</p>" }),
      ctx,
      { save: true },
    );
    expect(saved).toHaveLength(0);
    expect(r.text.startsWith("**Contact**")).toBe(true);
  });

  it("keeps R&D in a table card (React shows it as typed)", async () => {
    await settleReplyCards(block({ kind: "table", title: "R&D spend", columns: ["Team"], rows: [["R&D"]] }), ctx, { save: true });
    expect(saved).toHaveLength(1);
  });

  it.each([
    "Yes — 56 bookings last week, up 12%.",
    "| Channel | Spend |\n| --- | --- |\n| Meta | $41 |",
    "Run this:\n```html\n<div>zavi-ui</div>\n```",
    "Which week do you mean, Oct 5 or Oct 12?",
  ])("leaves a reply with no card unchanged: %s", async (text) => {
    const r = await settleReplyCards(text, ctx, { save: true });
    expect(r.text).toBe(text);
    expect(saved).toHaveLength(0);
  });
});

describe("cardToText", () => {
  it("renders posts and charts readably", () => {
    expect(cardToText({ kind: "posts", title: "Options", posts: [{ channel: "instagram", label: "A", payload: { text: "Rent a car for gig work" } }] })).toBe(
      "**Options**\n- A: Rent a car for gig work",
    );
    expect(cardToText({ kind: "posts", title: "X", posts: [{ channel: "x", label: "Thread", payload: { text: "Root", thread: ["Part 2", "Part 3"] } }] })).toBe(
      "**X**\n- Thread: Root / Part 2 / Part 3",
    );
    expect(cardToText({ kind: "chart", title: "Spend", unit: "$", series: [{ label: "Mon", value: 12 }] })).toBe("**Spend**\n- Mon: $12");
  });
});
