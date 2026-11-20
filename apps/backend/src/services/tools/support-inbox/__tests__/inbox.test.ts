
import { describe, it, expect, vi, beforeEach } from "vitest";

const getEnabledStreamableServer = vi.fn();
const listStreamableTools = vi.fn();
const callStreamableTool = vi.fn();
const logReview = vi.fn();
const getConnectorToken = vi.fn();

vi.mock("@/services/mcp/discovery", () => ({
  getEnabledStreamableServer: (...a: unknown[]) => getEnabledStreamableServer(...a),
}));
vi.mock("@/services/mcp/streamable-client", () => ({
  listStreamableTools: (...a: unknown[]) => listStreamableTools(...a),
  callStreamableTool: (...a: unknown[]) => callStreamableTool(...a),
}));
vi.mock("@/services/logging/log-review", () => ({
  logReview: (...a: unknown[]) => logReview(...a),
}));
vi.mock("@/services/connectors/composio/api-key", () => ({
  buildComposioMcpUrl: () => "x",
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    const q: any = { from: () => q, select: () => q, eq: () => q, maybeSingle: async () => ({ data: { slug: "composio.gmail" }, error: null }) };
    return q;
  },
}));
vi.mock("@/services/connectors/core/token", () => ({
  getConnectorToken: (...a: unknown[]) => getConnectorToken(...a),
}));

import {
  supportInboxListThreadsTool,
  supportInboxGetThreadTool,
} from "@/services/tools/support-inbox/inbox";

const ctx = { tenant_id: "tenant-abc", run_id: "run-1", agent_slug: "dispute-response", log: () => {} };
const GMAIL_ROW = { tenant_id: "tenant-abc", server_id: "composio", transport: "streamable-http", url: "x", command: null, args: null, enabled: true };

beforeEach(() => {
  getEnabledStreamableServer.mockReset();
  listStreamableTools.mockReset();
  callStreamableTool.mockReset();
  logReview.mockReset();
  getConnectorToken.mockReset();
  getConnectorToken.mockResolvedValue(null);
  vi.unstubAllGlobals();
});

describe("support_inbox — graceful not-connected", () => {
  it("list_threads returns connected:false + empty when no Gmail is connected", async () => {
    getEnabledStreamableServer.mockResolvedValue(null);
    const out = (await supportInboxListThreadsTool.execute(ctx, {})) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(out.connected).toBe(false);
    expect(out.threads).toEqual([]);
    expect(callStreamableTool).not.toHaveBeenCalled();
  });

  it("get_thread returns connected:false when no Gmail is connected", async () => {
    getEnabledStreamableServer.mockResolvedValue(null);
    const out = (await supportInboxGetThreadTool.execute(ctx, { thread_id: "t1" })) as Record<string, unknown>;
    expect(out.connected).toBe(false);
    expect(out.messages).toEqual([]);
  });
});

describe("support_inbox — tenant scoping (C8)", () => {
  it("fetches the Gmail row BY ctx.tenant_id, not any LLM-supplied value", async () => {
    getEnabledStreamableServer.mockResolvedValue(null);
    await supportInboxListThreadsTool.execute(ctx, { limit: 5 });
    expect(getEnabledStreamableServer).toHaveBeenCalledWith("tenant-abc", "composio");
  });
});

describe("support_inbox — read-only tool selection", () => {
  it("never selects a write-verb tool even if advertised", async () => {
    getEnabledStreamableServer.mockResolvedValue(GMAIL_ROW);
    listStreamableTools.mockResolvedValue([
      { tool_name: "GMAIL_SEND_EMAIL" },
      { tool_name: "GMAIL_DELETE_MESSAGE" },
    ]);
    const out = (await supportInboxListThreadsTool.execute(ctx, {})) as Record<string, unknown>;
    expect(out.threads).toEqual([]);
    expect(callStreamableTool).not.toHaveBeenCalled();
    expect(out.note).toMatch(/no readable list tool/i);
  });

  it("selects the list read tool and normalizes items with a capped snippet", async () => {
    getEnabledStreamableServer.mockResolvedValue(GMAIL_ROW);
    listStreamableTools.mockResolvedValue([
      { tool_name: "GMAIL_SEND_EMAIL" },
      { tool_name: "GMAIL_LIST_THREADS" },
    ]);
    const bigBody = "x".repeat(500);
    callStreamableTool.mockResolvedValue({
      ok: true,
      is_error: false,
      content: JSON.stringify({ messages: [{ id: "m1", subject: "Refund?", from: "buyer@x.com", snippet: bigBody }] }),
      ms: 5,
    });
    const out = (await supportInboxListThreadsTool.execute(ctx, { limit: 10 })) as Record<string, unknown>;
    expect(out.connected).toBe(true);
    const threads = out.threads as Array<Record<string, unknown>>;
    expect(threads).toHaveLength(1);
    expect(threads[0].thread_id).toBe("m1");
    expect(threads[0].subject).toBe("Refund?");
    expect((threads[0].snippet as string).length).toBe(200);
    expect(callStreamableTool).toHaveBeenCalledWith("tenant-abc", GMAIL_ROW, "GMAIL_LIST_THREADS", expect.anything());
  });
});

describe("support_inbox — get_thread normalization + body cap", () => {
  it("caps the UNTRUSTED body and maps fields defensively", async () => {
    getEnabledStreamableServer.mockResolvedValue(GMAIL_ROW);
    listStreamableTools.mockResolvedValue([{ tool_name: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID" }]);
    const hugeBody = "y".repeat(9000);
    callStreamableTool.mockResolvedValue({
      ok: true,
      is_error: false,
      content: JSON.stringify([{ from: "buyer@x.com", subject: "Re: Refund", body: hugeBody }]),
      ms: 5,
    });
    const out = (await supportInboxGetThreadTool.execute(ctx, { thread_id: "t1" })) as Record<string, unknown>;
    const msgs = out.messages as Array<Record<string, unknown>>;
    expect(msgs[0].from).toBe("buyer@x.com");
    expect((msgs[0].body as string).length).toBe(4000);
  });

  it("returns an error envelope (never throws) when the underlying read errors", async () => {
    getEnabledStreamableServer.mockResolvedValue(GMAIL_ROW);
    listStreamableTools.mockResolvedValue([{ tool_name: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID" }]);
    callStreamableTool.mockResolvedValue({ ok: false, is_error: true, content: "boom", ms: 1 });
    const out = (await supportInboxGetThreadTool.execute(ctx, { thread_id: "t1" })) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(out.error).toBe("support_inbox_read_failed");
  });
});

describe("support_inbox — shadow-observe logs counts only (no PII)", () => {
  it("logs a review row with thread_count + tool name, never subjects/bodies", async () => {
    getEnabledStreamableServer.mockResolvedValue(GMAIL_ROW);
    listStreamableTools.mockResolvedValue([{ tool_name: "GMAIL_LIST_THREADS" }]);
    callStreamableTool.mockResolvedValue({
      ok: true,
      is_error: false,
      content: JSON.stringify({ messages: [{ id: "m1", subject: "SECRET SUBJECT", snippet: "SECRET BODY" }] }),
      ms: 5,
    });
    await supportInboxListThreadsTool.execute(ctx, {});
    expect(logReview).toHaveBeenCalledTimes(1);
    const arg = logReview.mock.calls[0][0] as { feature: string; meta: Record<string, unknown> };
    expect(arg.feature).toBe("support_inbox");
    expect(arg.meta.thread_count).toBe(1);
    const serialized = JSON.stringify(arg);
    expect(serialized).not.toContain("SECRET SUBJECT");
    expect(serialized).not.toContain("SECRET BODY");
  });
});

describe("support_inbox — native Intercom rail (Gap 4 S6)", () => {
  it("PREFERS Intercom over Gmail: list_threads reads Intercom REST, never touches gmail", async () => {
    getConnectorToken.mockResolvedValue("ic_tok");
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({
        conversations: [
          { id: "cv1", created_at: 1700000000, source: { subject: "Refund please", author: { email: "buyer@x.com" }, body: "<p>Hi <b>there</b></p>" } },
        ],
      }),
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

    const out = (await supportInboxListThreadsTool.execute(ctx, { limit: 10 })) as Record<string, unknown>;
    expect(out.source).toBe("intercom");
    const threads = out.threads as Array<Record<string, unknown>>;
    expect(threads[0].thread_id).toBe("cv1");
    expect(threads[0].subject).toBe("Refund please");
    expect(threads[0].from).toBe("buyer@x.com");
    expect(threads[0].snippet).toBe("Hi there");
    expect(getEnabledStreamableServer).not.toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/conversations");
  });

  it("get_thread maps source + conversation_parts, strips HTML, caps body", async () => {
    getConnectorToken.mockResolvedValue("ic_tok");
    const huge = "z".repeat(9000);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id: "cv1",
        created_at: 1700000000,
        source: { subject: "Refund", author: { email: "buyer@x.com" }, body: "<p>opening</p>" },
        conversation_parts: {
          conversation_parts: [
            { author: { type: "admin", name: "Agent" }, created_at: 1700000100, body: `<div>${huge}</div>` },
          ],
        },
      }),
    } as Response)));

    const out = (await supportInboxGetThreadTool.execute(ctx, { thread_id: "cv1" })) as Record<string, unknown>;
    expect(out.source).toBe("intercom");
    const msgs = out.messages as Array<Record<string, unknown>>;
    expect(msgs[0].from).toBe("buyer@x.com");
    expect(msgs[0].body).toBe("opening");
    expect(msgs[1].from).toBe("Agent");
    expect((msgs[1].body as string).length).toBe(4000);
  });

  it("Intercom read failure returns an error envelope (never throws), source=intercom", async () => {
    getConnectorToken.mockResolvedValue("ic_tok");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) } as Response)));
    const out = (await supportInboxListThreadsTool.execute(ctx, {})) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(out.source).toBe("intercom");
    expect(out.error).toBe("support_inbox_read_failed");
  });

  it("falls back to Gmail path when Intercom is NOT connected", async () => {
    getConnectorToken.mockResolvedValue(null);
    getEnabledStreamableServer.mockResolvedValue(null);
    const out = (await supportInboxListThreadsTool.execute(ctx, {})) as Record<string, unknown>;
    expect(out.connected).toBe(false);
    expect(out.source).toBe("none");
    expect(getEnabledStreamableServer).toHaveBeenCalledWith("tenant-abc", "composio");
  });
});
