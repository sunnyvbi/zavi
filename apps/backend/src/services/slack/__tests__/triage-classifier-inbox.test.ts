
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../knowledge", () => ({
  loadKnowledgePack: vi.fn(async () => ({
    sources: [{ path: "zavi-overview.md", content: "# Zavi\n\nAn AI cofounder team." }],
  })),
  _resetKnowledgeCache: vi.fn(),
}));
vi.mock("../triage-tools", () => ({
  buildClassifierTools: vi.fn(() => []),
  callClassifierTool: vi.fn(),
}));
vi.mock("@/services/anthropic", () => ({
  getAnthropic: vi.fn(() => ({ messages: { create: vi.fn() } })),
  DEFAULT_FAST_MODEL: "claude-sonnet-4-6",
}));
vi.mock("@/services/agents/company-fact-sheet", () => ({
  buildCompanyFactSheet: vi.fn(async () => "## Who you work for\nYou work for **UpcarAI**."),
}));
vi.mock("@/services/agents/agent-inbox-context", () => ({
  buildInboxAddressBlock: vi.fn(
    async () =>
      "## Your email inbox\nYou have a shared team email inbox: **upcarai@inbox.zaviagent.com**.",
  ),
}));

import { buildSystemPrompt, classifyMessage } from "../triage-classifier";
import { getAnthropic } from "@/services/anthropic";
import { buildInboxAddressBlock } from "@/services/agents/agent-inbox-context";

const AGENTS = [{ slug: "engineer", name: "Engineer", description: "Reads code." }];

async function systemPromptFor(tenant_id = "t1"): Promise<string> {
  let captured = "";
  const fakeCreate = vi.fn(async (args: { system: string }) => {
    captured = args.system;
    return {
      content: [
        {
          type: "text",
          text: '<triage>{"tier":1,"reply":"ok","citations":["zavi-overview.md"],"confidence":"high"}</triage>',
        },
      ],
    };
  });
  vi.mocked(getAnthropic).mockReturnValue({
    messages: { create: fakeCreate },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  await classifyMessage({
    message_text: "Whats your email id? I want to forward a pdf for review",
    active_agents: AGENTS,
    tenant_id,
    event: { channel_id: "C", thread_ts: "1" },
  });
  return captured;
}

describe("Slack Tier-1 — inbox address reaches the classifier prompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("puts the real inbox address into the system prompt it sends", async () => {
    const system = await systemPromptFor();
    expect(system).toContain("upcarai@inbox.zaviagent.com");
  });

  it("renders the address inside <company_context> (authoritative per-tenant section)", async () => {
    const system = await systemPromptFor();
    const block = system.slice(
      system.indexOf("<company_context>"),
      system.indexOf("</company_context>"),
    );
    expect(block).toContain("upcarai@inbox.zaviagent.com");
  });

  it("resolves the address for the SAME tenant the message came from (C8)", async () => {
    await systemPromptFor("tenant-abc");
    expect(buildInboxAddressBlock).toHaveBeenCalledWith("tenant-abc");
  });

  it("keeps the company fact sheet too (inbox does not displace it)", async () => {
    const system = await systemPromptFor();
    expect(system).toContain("UpcarAI");
    expect(system).toContain("upcarai@inbox.zaviagent.com");
  });

  it("puts the inbox block BEFORE the fact sheet so a long sheet can't truncate the address off", async () => {
    const system = await systemPromptFor();
    expect(system.indexOf("Your email inbox")).toBeLessThan(system.indexOf("Who you work for"));
  });

  it("degrades silently when the tenant has no inbox identity", async () => {
    vi.mocked(buildInboxAddressBlock).mockResolvedValueOnce(undefined);
    const system = await systemPromptFor();
    expect(system).not.toContain("@inbox.zaviagent.com");
    expect(system).toContain("UpcarAI");
  });
});

describe("buildSystemPrompt — companyContext carries the address verbatim", () => {
  it("renders a supplied inbox block", () => {
    const prompt = buildSystemPrompt(
      AGENTS,
      [],
      "## Your email inbox\nYou have a shared team email inbox: **upcarai@inbox.zaviagent.com**.",
    );
    expect(prompt).toContain("upcarai@inbox.zaviagent.com");
  });
});
