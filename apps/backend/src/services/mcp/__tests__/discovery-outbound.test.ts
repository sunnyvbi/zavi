import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ serviceClientMock: vi.fn() }));

vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));

import { discoverToolsForTenant, _clearToolCacheForTests } from "../discovery";
import { callOutboundTool, listOutboundTools } from "../internal/outbound";

const OUTBOUND = ["outbound__list_email_lists", "outbound__propose_email"];

const savedFlag = process.env.ALL_AGENTS_ALL_TOOLS;

afterEach(() => {
  if (savedFlag === undefined) delete process.env.ALL_AGENTS_ALL_TOOLS;
  else process.env.ALL_AGENTS_ALL_TOOLS = savedFlag;
});

beforeEach(() => {
  _clearToolCacheForTests();
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }),
  });
});

describe("Zavi's own email tools reach the agents that declare them", () => {
  it("with per-agent allowlists on, an agent declaring both gets both, served by the outbound server, nothing disconnected", async () => {
    process.env.ALL_AGENTS_ALL_TOOLS = "0";
    const res = await discoverToolsForTenant("t-1", OUTBOUND);
    const outbound = res.tools.filter((t) => t.name.startsWith("outbound__"));
    expect(outbound.map((t) => t.name).sort()).toEqual([...OUTBOUND].sort());
    for (const t of outbound) expect(t.server_id).toBe("outbound");
    expect(res.disconnected_connectors).not.toContain("outbound");
  });

  it("with the platform default (every agent sees every served tool) they are served too", async () => {
    delete process.env.ALL_AGENTS_ALL_TOOLS;
    const res = await discoverToolsForTenant("t-1", ["email_campaign__list_audiences"]);
    const outbound = res.tools.filter((t) => t.server_id === "outbound").map((t) => t.name).sort();
    expect(outbound).toEqual([...OUTBOUND].sort());
  });

  it("with per-agent allowlists on, an agent that declares none of them sees none of them", async () => {
    process.env.ALL_AGENTS_ALL_TOOLS = "0";
    const res = await discoverToolsForTenant("t-1", ["web_fetch__fetch"]);
    expect(res.tools.some((t) => t.server_id === "outbound")).toBe(false);
  });

  it("the server exposes only a list read and propose tools, never a direct send", () => {
    const tools = listOutboundTools();
    expect(tools.map((t) => t.tool_name).sort()).toEqual(["list_email_lists", "propose_email"]);
    for (const t of tools) {
      if (t.tool_name.startsWith("list_")) expect(t.effect).toBe("read");
      else expect(t.tool_name).toMatch(/^propose_/);
    }
  });
});

describe("a call to the outbound server runs the real tool", () => {
  it("the retired text-only bulk proposal is not served (a Zavi list send is email__propose_campaign)", async () => {
    const res = await callOutboundTool({ tenant_id: "t-1" }, "propose_cohort_email", {
      list_name: "Newsletter",
      subject: "Hello",
      body_text: "Hi there",
    });
    expect(res.ok).toBe(false);
    expect(JSON.parse(res.content)).toMatchObject({ error: "tool_unknown" });
  });

  it("an unknown tool name answers tool_unknown instead of throwing", async () => {
    const res = await callOutboundTool({ tenant_id: "t-1" }, "send_now", {});
    expect(res.ok).toBe(false);
    expect(JSON.parse(res.content)).toMatchObject({ error: "tool_unknown" });
  });
});
