import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/mcp/execute", () => ({
  callMcpTool: vi.fn(),
}));

import { buildClassifierTools, callClassifierTool, _internal } from "../triage-tools";
import { callMcpTool } from "@/services/mcp/execute";

describe("triage-tools.ALLOWED_TOOLS", () => {
  it("exposes only the 3 whitelisted tools", () => {
    const names = buildClassifierTools().map((t) => t.name).sort();
    expect(names).toEqual(["jira__get_issue", "jira__search", "slack__read_thread"]);
  });

  it("does NOT expose jira write tools (jira.create_issue, jira.add_comment)", () => {
    const names = buildClassifierTools().map((t) => t.name);
    expect(names).not.toContain("jira__create_issue");
    expect(names).not.toContain("jira__add_comment");
  });

  it("does NOT expose slack write tools (slack.post_message)", () => {
    const names = buildClassifierTools().map((t) => t.name);
    expect(names).not.toContain("slack__post_message");
  });

  it("strips channel_id + thread_ts from slack__read_thread model schema", () => {
    const tool = buildClassifierTools().find((t) => t.name === "slack__read_thread");
    expect(tool).toBeDefined();
    const props = ((tool!.input_schema as { properties?: Record<string, unknown> }).properties ?? {});
    expect(props).not.toHaveProperty("channel_id");
    expect(props).not.toHaveProperty("thread_ts");
  });
});

describe("triage-tools.shapeOutput — jira.search", () => {
  it("caps issues at 10 and projects to allowlist fields only", () => {
    const raw = {
      total: 50,
      issues: Array.from({ length: 50 }, (_, i) => ({
        key: `PROJ-${i}`,
        fields: {
          summary: "x".repeat(500),
          status: { name: "Open" },
          assignee: { displayName: "Alice", emailAddress: "alice@example.com" },
        },
      })),
    };
    const out = _internal.shapeOutput("jira.search", raw) as {
      total: number;
      issues: Array<{ key: string; summary: string; status: string; assignee: string }>;
    };
    expect(out.total).toBe(50);
    expect(out.issues).toHaveLength(10);
    expect(out.issues[0].summary.length).toBeLessThanOrEqual(201);
    expect(JSON.stringify(out)).not.toContain("alice@example.com");
  });
});

describe("triage-tools.shapeOutput — capBytes overflow path (Codex P3)", () => {
  it("returns valid JSON even when input exceeds 4KB cap", () => {
    const raw = {
      total: 1000,
      issues: Array.from({ length: 500 }, (_, i) => ({
        key: `BIG-${i}`,
        fields: {
          summary: "x".repeat(300),
          status: { name: "Open" },
          assignee: { displayName: "Alice" },
        },
      })),
    };
    const out = _internal.shapeOutput("jira.search", raw);
    const s = JSON.stringify(out);
    expect(() => JSON.parse(s)).not.toThrow();
    expect(Buffer.byteLength(s, "utf-8")).toBeLessThanOrEqual(_internal.MAX_TOTAL_BYTES);
  });
});

describe("triage-tools.shapeOutput — slack.read_thread", () => {
  it("caps messages at 20", () => {
    const raw = {
      messages: Array.from({ length: 50 }, (_, i) => ({
        ts: `${1700000000 + i}.000000`,
        user: `U${i}`,
        text: `msg ${i}`,
      })),
    };
    const out = _internal.shapeOutput("slack.read_thread", raw) as {
      messages: Array<unknown>;
    };
    expect(out.messages.length).toBeLessThanOrEqual(20);
  });
});

describe("triage-tools.callClassifierTool — context binding", () => {
  it("injects channel_id + thread_ts from caller, ignoring model-supplied values", async () => {
    const spy = vi.mocked(callMcpTool);
    spy.mockResolvedValueOnce({
      ok: true,
      is_error: false,
      content: JSON.stringify({ messages: [] }),
      ms: 5,
    });
    await callClassifierTool(
      { tenant_id: "t1", run_id: "" },
      { channel_id: "C-RIGHT", thread_ts: "1700000000.000000" },
      "slack__read_thread",
      { channel_id: "C-HIJACK", thread_ts: "1700000099.999999", limit: 5 },
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0][3] as Record<string, unknown>;
    expect(args.channel_id).toBe("C-RIGHT");
    expect(args.thread_ts).toBe("1700000000.000000");
    expect(args.limit).toBe(5);
  });

  it("refuses tools not in ALLOWED_TOOLS", async () => {
    const out = await callClassifierTool(
      { tenant_id: "t1", run_id: "" },
      { channel_id: "C", thread_ts: "1" },
      "jira__create_issue",
      { project_key: "X", summary: "y" },
    );
    expect(out.is_error).toBe(true);
    expect((out.shaped as { error: string }).error).toBe("tool_denied");
  });
});
