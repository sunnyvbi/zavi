
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  upload: vi.fn(async () => ({ error: null })),
  upsertSingle: vi.fn(async () => ({ data: { id: "art-1" }, error: null })),
  tools: [] as Array<{ name: string; description: string; handler: (args: unknown) => Promise<unknown>; alwaysLoad?: boolean }>,
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantStorage: () => ({ from: () => ({ upload: m.upload }) }),
  tenantClient: () => ({
    from: () => ({ upsert: () => ({ select: () => ({ single: m.upsertSingle }) }) }),
  }),
}));
vi.mock("@/services/reports/constants", () => ({ ARTIFACT_BUCKET: "agent-artifacts" }));
const flag = vi.hoisted(() => ({ scripts: false }));
vi.mock("@/services/settings", () => ({ getBoolSetting: async () => flag.scripts }));
vi.mock("@/services/agents/html-preview-artifacts", () => ({
  sanitizePreviewHtml: (raw: string, opts?: { allowScripts?: boolean }) =>
    raw.includes("<script") && !opts?.allowScripts
      ? { ok: false, reason: "artifact_unsafe" }
      : { ok: true, html: raw.replace("<b>", "<strong>").replace("</b>", "</strong>"), bytes: raw.length, sha256: "x" },
}));
const cards = vi.hoisted(() => ({
  pick: vi.fn(),
  attach: vi.fn(async (a: { card_id: string }) => ({ shown: true, already: false, card_id: a.card_id, table: "decisions", what: "x" }) as unknown),
}));
vi.mock("@/services/approvals/chat-cards", () => ({
  CHAT_CARDS_MAX: 5,
  NEEDS_YOU_LINK: "/workspace?tab=needs-you",
  UnknownChannelError: class UnknownChannelError extends Error {},
  pickChatCards: cards.pick,
  GROWTH_LINK: "/workspace?tab=growth-strategy",
  chatCardsReply: (p: { cards: unknown[]; not_shown: string[] }) => `Showed ${p.cards.length}; not ${p.not_shown.join(",")}`,
}));
vi.mock("@/services/approvals/chat-card-attach", () => ({ attachCardToChat: cards.attach }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, description: string, _shape: unknown, handler: (a: unknown) => Promise<unknown>, extras?: { alwaysLoad?: boolean }) => {
    const t = { name, description, handler, alwaysLoad: extras?.alwaysLoad === true };
    m.tools.push(t);
    return t;
  },
  createSdkMcpServer: (cfg: { name: string; tools: unknown[] }) => cfg,
}));

import { mcpUiTools } from "../mcp-ui-tools";
import { UI_TOOL_HALT_MESSAGE } from "../ui-tools";

const T = "11111111-1111-1111-1111-111111111111";
const ctx = () => ({
  tenant_id: T,
  run_id: "run-1",
  agent_slug: "chief-of-staff",
  frontend_tools: [{ name: "open_tab" as const, description: "Open a workspace tab", parameters: { type: "object", properties: { kind: { type: "string" } } } }],
});

beforeEach(() => {
  m.tools.length = 0;
  m.upload.mockClear();
  m.upsertSingle.mockClear();
});

describe("mcpUiTools", () => {
  it("registers the declared frontend tool + the three show_* tools on a server named ui", async () => {
    const server = (await mcpUiTools(ctx())) as unknown as { name: string; tools: unknown[] };
    expect(server.name).toBe("ui");
    expect(m.tools.map((t) => t.name)).toEqual(["open_tab", "show_chart", "show_kpis", "show_table", "show_posts", "show_html"]);
  });

  it("a frontend tool only halts the turn — the dispatcher's own tool_call rows are the hand-off", async () => {
    await mcpUiTools(ctx());
    const res = (await m.tools[0].handler({ kind: "calendar" })) as { content: Array<{ text: string }> };
    expect(res.content[0].text).toBe(UI_TOOL_HALT_MESSAGE);
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.upsertSingle).not.toHaveBeenCalled();
  });

  it("show_chart validates and stores the block under <tenant>/<run>/ with the block MIME", async () => {
    await mcpUiTools(ctx());
    const chart = m.tools.find((t) => t.name === "show_chart")!;
    const res = (await chart.handler({ title: "Signups", series: [{ label: "Mon", value: 3 }] })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toMatch(/Rendered "Signups" as a chart card/);
    expect(res.content[0].text).toMatch(/call show_chart AGAIN/i);
    expect(res.content[0].text).toMatch(/SAME series plus `colors`/);
    expect(res.content[0].text).toMatch(/Never redraw this chart as HTML/i);
    const [path, bytes, opts] = m.upload.mock.calls[0] as unknown as [string, Buffer, { contentType: string }];
    expect(path).toBe(`${T}/run-1/ui-block-1.json`);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual({ kind: "chart", title: "Signups", variant: "bar", series: [{ label: "Mon", value: 3 }], verified: false });
    expect(opts.contentType).toBe("application/vnd.zavi.ui+json");
    expect(m.upsertSingle).toHaveBeenCalledOnce();
  });

  it("show_chart with a result_id stores the result's values, verified, with a receipt", async () => {
    const { putResult } = await import("@/services/analytics/metric-results");
    putResult(T, "run-1", {
      result_id: "m_00000000aa",
      kind: "metric",
      value: 12,
      receipt: { source: "ga4", metric_id: "sessions", window: { since: "2026-09-01", until: "2026-09-02" }, fetched_at: "2026-09-03T00:00:00.000Z" },
      unit: "count",
      series: [
        { start: "2026-09-01", end: "2026-09-01", value: 5, partial: false },
        { start: "2026-09-02", end: "2026-09-02", value: 7, partial: false },
      ],
    });
    await mcpUiTools(ctx());
    const chart = m.tools.find((t) => t.name === "show_chart")!;
    const res = (await chart.handler({ title: "Sessions", result_id: "m_00000000aa" })) as { isError?: boolean };
    expect(res.isError).toBeFalsy();
    const [, bytes] = m.upload.mock.calls[0] as unknown as [string, Buffer];
    const stored = JSON.parse(bytes.toString("utf8"));
    expect(stored.series).toEqual([{ label: "2026-09-01", value: 5 }, { label: "2026-09-02", value: 7 }]);
    expect(stored.verified).toBe(true);
    expect(stored.receipt).toMatchObject({ source: "ga4", metric_id: "sessions" });
    expect(stored.as_of).toBe("2026-09-03T00:00:00.000Z");
  });

  it("show_chart with an unknown result_id is rejected and stores nothing", async () => {
    await mcpUiTools(ctx());
    const chart = m.tools.find((t) => t.name === "show_chart")!;
    const res = (await chart.handler({ title: "x", result_id: "m_ffffffffff" })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/get_metric/);
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("show_table refuses an invalid block: error result, nothing stored", async () => {
    await mcpUiTools(ctx());
    const table = m.tools.find((t) => t.name === "show_table")!;
    const res = (await table.handler({ title: "t", columns: [], rows: [] })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Block rejected/);
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("a bucket that does not yet allow the block MIME → same bytes re-uploaded under the fallback type; the row keeps the true mime", async () => {
    m.upload.mockResolvedValueOnce({ error: { message: "mime type application/vnd.zavi.ui+json is not supported" } } as never);
    await mcpUiTools(ctx());
    const chart = m.tools.find((t) => t.name === "show_chart")!;
    const res = (await chart.handler({ title: "x", series: [{ label: "a", value: 1 }] })) as { isError?: boolean };
    expect(res.isError).toBeUndefined();
    expect(m.upload).toHaveBeenCalledTimes(2);
    expect((m.upload.mock.calls[1] as unknown as [string, Buffer, { contentType: string }])[2].contentType).toBe("text/csv");
    expect(m.upsertSingle).toHaveBeenCalledOnce();
  });

  it("show_html stores the SANITIZED html (not the model's), and refuses an unsafe document", async () => {
    await mcpUiTools(ctx());
    const html = m.tools.find((t) => t.name === "show_html")!;
    const ok = (await html.handler({ title: "Funnel", html: "<b>hi</b><svg/>" })) as { isError?: boolean };
    expect(ok.isError).toBeUndefined();
    const [, bytes] = m.upload.mock.calls[0] as unknown as [string, Buffer];
    expect(JSON.parse(bytes.toString("utf8"))).toEqual({ kind: "html", title: "Funnel", html: "<strong>hi</strong><svg/>" });
    const bad = (await html.handler({ title: "x", html: "<script>alert(1)</script>" })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/artifact_unsafe/);
    expect(m.upload).toHaveBeenCalledTimes(1);
  });

  it("show_html marks the block `scripts: true` ONLY when the tenant flag is on (env override for local)", async () => {
    flag.scripts = true;
    try {
      await mcpUiTools(ctx());
      const html = m.tools.find((t) => t.name === "show_html")!;
      await html.handler({ title: "Live", html: "<div>x</div><script>1</script>" });
      const [, bytes] = m.upload.mock.calls[0] as unknown as [string, Buffer];
      expect(JSON.parse(bytes.toString("utf8"))).toMatchObject({ kind: "html", scripts: true, html: "<div>x</div><script>1</script>" });
    } finally {
      flag.scripts = false;
    }
    m.tools.length = 0; m.upload.mockClear();
    await mcpUiTools(ctx());
    const html2 = m.tools.find((t) => t.name === "show_html")!;
    await html2.handler({ title: "Static", html: "<div>x</div>" });
    const [, b2] = m.upload.mock.calls[0] as unknown as [string, Buffer];
    expect(JSON.parse(b2.toString("utf8"))).not.toHaveProperty("scripts");
  });

  it("a storage failure is reported to the model, never thrown into the run", async () => {
    m.upload.mockResolvedValueOnce({ error: { message: "bucket down" } } as never);
    await mcpUiTools(ctx());
    const chart = m.tools.find((t) => t.name === "show_chart")!;
    const res = (await chart.handler({ title: "x", series: [{ label: "a", value: 1 }] })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/bucket down/);
  });

  it("reads a table footnote's figures, and skips dates and spans in a delta", async () => {
    const { shownRowsOf } = await import("../mcp-ui-tools");
    expect(
      shownRowsOf({ kind: "table", title: "t", columns: ["m"], rows: [["July"]], note: "*Based on 1,000 customers." }),
    ).toEqual([["July"], ["1,000"]]);
    expect(
      shownRowsOf({ kind: "kpi", title: "k", items: [{ label: "x", value: "10", delta: "+12% vs Sep 25, over 365 days" }] }),
    ).toEqual([["10", "+12%"]]);
    expect(
      shownRowsOf({ kind: "kpi", title: "k", items: [{ label: "x", value: "10", delta: "+12% vs $1,200 m/m, trailing 365-day" }] }),
    ).toEqual([["10", "+12%", "$1,200"]]);
  });
});

describe("shownRowsOf — what a card shows, for the Sources footnote", () => {
  it("keeps table rows as rows and reads chart and KPI values", async () => {
    const { shownRowsOf } = await import("../mcp-ui-tools");
    expect(
      shownRowsOf({ kind: "table", title: "t", columns: ["m", "n"], rows: [["July", 1587], ["Aug", null]] }),
    ).toEqual([["July", "1587"], ["Aug", ""]]);
    expect(
      shownRowsOf({ kind: "chart", title: "c", variant: "bar", series: [{ label: "a", value: 12 }] }),
    ).toEqual([["12"]]);
    expect(
      shownRowsOf({ kind: "kpi", title: "k", items: [{ label: "x", value: "$4.2K", delta: "+12% vs 8% last week" }] }),
    ).toEqual([["$4.2K", "+12%", "8%"]]);
  });
});

describe("show_approval_cards", () => {
  const D1 = "00000000-0000-4000-8000-000000000001";
  const D2 = "00000000-0000-4000-8000-000000000002";
  const defaultAttach = async (a: { card_id: string }) => ({ shown: true, already: false, card_id: a.card_id, table: "decisions", what: "x" }) as unknown;
  beforeEach(() => {
    cards.pick.mockReset();
    cards.attach.mockReset();
    cards.attach.mockImplementation(defaultAttach);
  });

  const two = () => ({
    cards: [
      { id: D1, decision_class: "google_ads.campaign_budget", home: "growth", emitted_at: "x" },
      { id: D2, decision_class: "pm.file_jira_bug", home: "needs_you", emitted_at: "y" },
    ],
    more: { growth: 0, needs_you: 0 },
    not_shown: [],
    channel_pages: [],
  });
  const handler = async () => {
    await mcpUiTools({ ...ctx(), approval_cards: true });
    return m.tools.find((x) => x.name === "show_approval_cards")!.handler;
  };

  it("exists only on a founder chat turn, and is always loaded", async () => {
    await mcpUiTools(ctx());
    expect(m.tools.map((t) => t.name)).not.toContain("show_approval_cards");
    m.tools.length = 0;
    await mcpUiTools({ ...ctx(), approval_cards: true });
    expect(m.tools.find((x) => x.name === "show_approval_cards")?.alwaysLoad).toBe(true);
  });

  it("shows each picked card through the chat-card attach path, under this reply", async () => {
    cards.pick.mockResolvedValue(two());
    const res = (await (await handler())({})) as { content: Array<{ text: string }>; isError?: boolean };
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe("Showed 2; not ");
    expect(cards.attach.mock.calls.map((c) => c[0])).toEqual([
      { tenant_id: T, run_id: "run-1", card_id: D1, table: "decisions", bringToLatest: true },
      { tenant_id: T, run_id: "run-1", card_id: D2, table: "decisions", bringToLatest: true },
    ]);
  });

  it("a card the attach refuses (decided meanwhile) is reported as not shown", async () => {
    cards.pick.mockResolvedValue(two());
    cards.attach.mockImplementationOnce(async (a: { card_id: string }) => ({ shown: false, reason: "not_waiting", card_id: a.card_id }));
    const res = (await (await handler())({})) as { content: Array<{ text: string }> };
    expect(res.content[0].text).toBe(`Showed 1; not ${D1}`);
  });

  it("a staff console turn (not a founder chat) says where the cards are, never that they were decided", async () => {
    cards.pick.mockResolvedValue(two());
    cards.attach.mockImplementation(async (a: { card_id: string }) => ({ shown: false, reason: "not_chat", card_id: a.card_id }));
    const res = (await (await handler())({})) as { content: Array<{ text: string }> };
    expect(res.content[0].text).toMatch(/not a founder chat[\s\S]*2 card\(s\) still wait/);
    expect(res.content[0].text).not.toMatch(/decided/);
  });

  it("a card that failed to show is named so the model can try once more; the others still show", async () => {
    cards.pick.mockResolvedValue(two());
    cards.attach.mockRejectedValueOnce(new Error("insert failed"));
    const res = (await (await handler())({})) as { content: Array<{ text: string }>; isError?: boolean };
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toMatch(new RegExp(`Showed 1[\\s\\S]*Could not show ${D1}`));
  });

  it("passes the founder's channel and ids through, and rejects more than 5 ids", async () => {
    cards.pick.mockResolvedValue({ cards: [], more: { growth: 0, needs_you: 0 }, not_shown: [], channel_pages: [] });
    const t = await handler();
    await t({ channel: "google_ads" });
    expect(cards.pick).toHaveBeenCalledWith(expect.anything(), { channel: "google_ads" });
    const tooMany = (await t({ decision_ids: [1, 2, 3, 4, 5, 6].map(String) })) as { isError?: boolean };
    expect(tooMany.isError).toBe(true);
  });

  it("a failed read answers with an error the model can act on, and shows nothing", async () => {
    cards.pick.mockRejectedValue(new Error("db down"));
    const res = (await (await handler())({})) as { content: Array<{ text: string }>; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Needs you/);
    expect(cards.attach).not.toHaveBeenCalled();
  });
});
