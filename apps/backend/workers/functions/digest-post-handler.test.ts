import { describe, it, expect, vi, beforeEach } from "vitest";

const callMcpTool = vi.fn();
vi.mock("@/services/mcp/execute", () => ({
  callMcpTool: (...args: unknown[]) => callMcpTool(...args),
}));

const logEvent = vi.fn();
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: (...args: unknown[]) => logEvent(...args),
}));

import { digestPostHandler, renderDigestText } from "./digest-post-handler";

const baseDecision = {
  id: "dec-1",
  tenant_id: "tenant-1",
  agent_run_id: "run-1",
  body: { rendered_markdown: "## Decide today\n1. payout test red since PR #1247" },
};

function listChannelsOk(channels: Array<Record<string, unknown>>) {
  return { ok: true, is_error: false, content: JSON.stringify({ channels }), ms: 1 };
}

beforeEach(() => {
  callMcpTool.mockReset();
  logEvent.mockReset();
});

function loggedCodes(): string[] {
  return logEvent.mock.calls.map((c) => (c[0] as { code?: string }).code ?? "");
}

describe("renderDigestText", () => {
  it("prefers rendered_markdown", () => {
    expect(renderDigestText({ rendered_markdown: "hello" })).toBe("hello");
  });
  it("falls back to fenced JSON when rendered_markdown is missing/blank", () => {
    const out = renderDigestText({ tier1: [{ title: "x" }] });
    expect(out.startsWith("```")).toBe(true);
    expect(out).toContain("tier1");
  });
  it("caps very long markdown under the Slack limit", () => {
    const out = renderDigestText({ rendered_markdown: "x".repeat(5000) });
    expect(out.length).toBeLessThanOrEqual(2900);
  });
});

describe("digestPostHandler", () => {
  it("posts to #zavi when the channel exists", async () => {
    callMcpTool
      .mockResolvedValueOnce(
        listChannelsOk([
          { id: "C_GEN", name: "general", is_archived: false },
          { id: "C_PRAXIS", name: "zavi", is_archived: false },
        ]),
      )
      .mockResolvedValueOnce({ ok: true, is_error: false, content: JSON.stringify({ ts: "1.2" }), ms: 1 });

    const res = await digestPostHandler(baseDecision);

    expect(res.ok).toBe(true);
    expect(callMcpTool).toHaveBeenCalledTimes(2);
    const postArgs = callMcpTool.mock.calls[1];
    expect(postArgs[1]).toBe("slack");
    expect(postArgs[2]).toBe("post_message");
    expect(postArgs[3]).toMatchObject({ channel_id: "C_PRAXIS" });
    expect((postArgs[3] as { text: string }).text).toContain("payout test red");
  });

  it("no-op SUCCESS (never rejects) when there is no #zavi channel", async () => {
    callMcpTool.mockResolvedValueOnce(
      listChannelsOk([{ id: "C_GEN", name: "general", is_archived: false }]),
    );

    const res = await digestPostHandler(baseDecision);

    expect(res.ok).toBe(true);
    expect(callMcpTool).toHaveBeenCalledTimes(1);
  });

  it("RECORDS the miss when there is no #zavi channel (outage must be queryable)", async () => {
    callMcpTool.mockResolvedValueOnce(
      listChannelsOk([
        { id: "C_GEN", name: "general", is_archived: false },
        { id: "C_FB", name: "zavi-feedback", is_archived: false },
      ]),
    );

    const res = await digestPostHandler(baseDecision);

    expect(res.ok).toBe(true);
    expect(loggedCodes()).toContain("digest_no_zavi_channel");
    const rec = logEvent.mock.calls[0][0] as { tenant_id?: string; level?: string };
    expect(rec.tenant_id).toBe("tenant-1");
    expect(rec.level).toBe("warn");
  });

  it("RECORDS the miss when the Slack post fails (channel exists but rejects)", async () => {
    callMcpTool
      .mockResolvedValueOnce(listChannelsOk([{ id: "C_PRAXIS", name: "zavi", is_archived: false }]))
      .mockResolvedValueOnce({
        ok: false,
        is_error: true,
        content: JSON.stringify({ error: "not_in_channel" }),
        ms: 1,
      });

    const res = await digestPostHandler(baseDecision);

    expect(res.ok).toBe(true);
    expect(loggedCodes()).toContain("digest_slack_post_failed");
  });

  it("stays SILENT on the happy path (no false outage signal)", async () => {
    callMcpTool
      .mockResolvedValueOnce(listChannelsOk([{ id: "C_PRAXIS", name: "zavi", is_archived: false }]))
      .mockResolvedValueOnce({ ok: true, is_error: false, content: JSON.stringify({ ts: "1.2" }), ms: 1 });

    const res = await digestPostHandler(baseDecision);

    expect(res.ok).toBe(true);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("ignores an archived channel named zavi", async () => {
    callMcpTool.mockResolvedValueOnce(
      listChannelsOk([{ id: "C_OLD", name: "zavi", is_archived: true }]),
    );

    const res = await digestPostHandler(baseDecision);

    expect(res.ok).toBe(true);
    expect(callMcpTool).toHaveBeenCalledTimes(1);
  });

  it("no-op SUCCESS when Slack isn't connected (list_channels errors)", async () => {
    callMcpTool.mockResolvedValueOnce({
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "slack_not_connected" }),
      ms: 1,
    });

    const res = await digestPostHandler(baseDecision);

    expect(res.ok).toBe(true);
    expect(callMcpTool).toHaveBeenCalledTimes(1);
  });

  it("no-op SUCCESS when the Slack post itself fails (best-effort delivery)", async () => {
    callMcpTool
      .mockResolvedValueOnce(listChannelsOk([{ id: "C_PRAXIS", name: "zavi", is_archived: false }]))
      .mockResolvedValueOnce({
        ok: false,
        is_error: true,
        content: JSON.stringify({ error: "not_in_channel" }),
        ms: 1,
      });

    const res = await digestPostHandler(baseDecision);

    expect(res.ok).toBe(true);
    expect(callMcpTool).toHaveBeenCalledTimes(2);
  });

  it("does not throw when list_channels returns malformed JSON", async () => {
    callMcpTool.mockResolvedValueOnce({ ok: true, is_error: false, content: "{not json", ms: 1 });

    const res = await digestPostHandler(baseDecision);

    expect(res.ok).toBe(true);
    expect(callMcpTool).toHaveBeenCalledTimes(1);
  });
});
