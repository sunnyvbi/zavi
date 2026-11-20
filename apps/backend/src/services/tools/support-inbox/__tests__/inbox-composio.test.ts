import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ slugs: ["composio.gmail"] as string[], readError: false, eqs: [] as [string, unknown][] }));
const getEnabledStreamableServer = vi.fn();
const listStreamableTools = vi.fn();
const callStreamableTool = vi.fn();

vi.mock("@/services/mcp/discovery", () => ({
  getEnabledStreamableServer: (...a: unknown[]) => getEnabledStreamableServer(...a),
}));
vi.mock("@/services/mcp/streamable-client", () => ({
  listStreamableTools: (...a: unknown[]) => listStreamableTools(...a),
  callStreamableTool: (...a: unknown[]) => callStreamableTool(...a),
}));
vi.mock("@/services/logging/log-review", () => ({ logReview: () => {} }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => null }));
vi.mock("@/services/connectors/composio/api-key", () => ({
  buildComposioMcpUrl: (t: string) => `https://backend.composio.dev/v3/mcp/srv?user_id=${t}`,
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => { m.eqs.push([k, v]); return q; },
        maybeSingle: async () => {
          if (m.readError) return { data: null, error: { message: "boom" } };
          const slug = m.eqs.find(([k]) => k === "slug")?.[1];
          return { data: m.slugs.includes(String(slug)) ? { slug } : null, error: null };
        },
      };
      return q;
    },
  }),
}));

import { supportInboxListThreadsTool, supportInboxGetThreadTool } from "../inbox";

const ctx = { tenant_id: "T1", run_id: "r1", agent_slug: "support-lead", log: () => {} };
const ROW = { tenant_id: "T1", server_id: "composio", transport: "streamable-http", url: "https://backend.composio.dev/v3/mcp/srv?user_id=OTHER", command: null, args: null, enabled: true };
const ok = (content: unknown) => ({ ok: true, is_error: false, content: JSON.stringify(content), ms: 1 });

beforeEach(() => {
  m.slugs = ["composio.gmail"]; m.readError = false; m.eqs = [];
  getEnabledStreamableServer.mockReset().mockResolvedValue(ROW);
  listStreamableTools.mockReset();
  callStreamableTool.mockReset().mockResolvedValue(ok({ messages: [] }));
});

describe("support inbox over Composio Gmail", () => {
  it("uses the tenant's composio row, with the MCP user_id rebuilt from the server tenant", async () => {
    listStreamableTools.mockResolvedValue([{ tool_name: "GMAIL_LIST_THREADS" }]);
    const out = (await supportInboxListThreadsTool.execute(ctx, {})) as Record<string, unknown>;
    expect(out.connected).toBe(true);
    expect(getEnabledStreamableServer).toHaveBeenCalledWith("T1", "composio");
    expect(m.eqs).toEqual(expect.arrayContaining([["tenant_id", "T1"], ["slug", "composio.gmail"]]));
    const row = callStreamableTool.mock.calls[0][1] as { url: string };
    expect(row.url).toContain("user_id=T1");
    expect(row.url).not.toContain("OTHER");
  });

  it("without a composio.gmail row: connected:false, the MCP server is never touched", async () => {
    m.slugs = [];
    const out = (await supportInboxListThreadsTool.execute(ctx, {})) as Record<string, unknown>;
    expect(out.connected).toBe(false);
    expect(getEnabledStreamableServer).not.toHaveBeenCalled();
    expect(listStreamableTools).not.toHaveBeenCalled();
  });

  it("a connector_metadata read error is treated as not connected (never a guess)", async () => {
    m.readError = true;
    const out = (await supportInboxGetThreadTool.execute(ctx, { thread_id: "t1" })) as Record<string, unknown>;
    expect(out.connected).toBe(false);
    expect(callStreamableTool).not.toHaveBeenCalled();
  });

  it("never selects a Gmail write or another app's tool, even ones whose names contain read-ish words", async () => {
    listStreamableTools.mockResolvedValue([
      { tool_name: "GMAIL_SEND_EMAIL" },
      { tool_name: "GMAIL_DELETE_THREAD" },
      { tool_name: "GMAIL_REPLY_TO_THREAD" },
      { tool_name: "GMAIL_MOVE_TO_TRASH" },
      { tool_name: "GMAIL_FETCH_AND_DELETE_MESSAGE" },
      { tool_name: "NOTION_LIST_PAGES" },
      { tool_name: "OUTLOOK_LIST_MESSAGES" },
    ]);
    const list = (await supportInboxListThreadsTool.execute(ctx, {})) as Record<string, unknown>;
    const get = (await supportInboxGetThreadTool.execute(ctx, { thread_id: "t1" })) as Record<string, unknown>;
    expect(list.threads).toEqual([]);
    expect(get.messages).toEqual([]);
    expect(callStreamableTool).not.toHaveBeenCalled();
  });

  it("selects the Gmail read tools (list threads, fetch by thread id) and passes thread_id", async () => {
    listStreamableTools.mockResolvedValue([
      { tool_name: "GMAIL_SEND_EMAIL" },
      { tool_name: "GMAIL_LIST_LABELS" },
      { tool_name: "GMAIL_LIST_THREADS" },
      { tool_name: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID" },
    ]);
    await supportInboxListThreadsTool.execute(ctx, {});
    expect(callStreamableTool.mock.calls[0][2]).toBe("GMAIL_LIST_THREADS");
    await supportInboxGetThreadTool.execute(ctx, { thread_id: "th_9" });
    expect(callStreamableTool.mock.calls[1][2]).toBe("GMAIL_FETCH_MESSAGE_BY_THREAD_ID");
    expect(callStreamableTool.mock.calls[1][3]).toEqual(expect.objectContaining({ thread_id: "th_9" }));
  });

  it("lists only Gmail tools: listStreamableTools is scoped to the gmail toolkit", async () => {
    listStreamableTools.mockResolvedValue([{ tool_name: "GMAIL_LIST_THREADS" }]);
    await supportInboxListThreadsTool.execute(ctx, {});
    await supportInboxGetThreadTool.execute(ctx, { thread_id: "t1" });
    for (const call of listStreamableTools.mock.calls) expect(call[2]).toEqual({ toolkits: ["gmail"] });
  });

  it("adversarial: a write that passes the old verb regex, or one advertised as approval-only, is never selected", async () => {
    listStreamableTools.mockResolvedValue([
      { tool_name: "GMAIL_GET_MESSAGE_ARCHIVE" },
      { tool_name: "GMAIL_LIST_THREADS_ARCHIVE" },
      { tool_name: "GMAIL_FETCH_EMAILS", requires_approval: true },
      { tool_name: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", requires_approval: true },
      { tool_name: "GMAIL_LIST_THREADS", annotations: { destructiveHint: true } },
      { tool_name: "GMAIL_DELETE_THREAD" },
      { tool_name: "GMAIL_THREAD_GET" },
    ]);
    const list = (await supportInboxListThreadsTool.execute(ctx, {})) as Record<string, unknown>;
    const get = (await supportInboxGetThreadTool.execute(ctx, { thread_id: "t1" })) as Record<string, unknown>;
    expect(list.threads).toEqual([]);
    expect(get.messages).toEqual([]);
    expect(callStreamableTool).not.toHaveBeenCalled();
  });

  it("an explicit requires_approval:false read is selected", async () => {
    listStreamableTools.mockResolvedValue([{ tool_name: "GMAIL_LIST_THREADS", requires_approval: false }]);
    await supportInboxListThreadsTool.execute(ctx, {});
    expect(callStreamableTool.mock.calls[0][2]).toBe("GMAIL_LIST_THREADS");
  });
});
