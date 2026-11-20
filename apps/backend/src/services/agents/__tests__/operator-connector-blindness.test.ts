import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: mocks.serviceClientMock,
}));

import {
  discoverToolsForTenant,
  _clearToolCacheForTests,
} from "@/services/mcp/discovery";

type McpRow = {
  tenant_id: string;
  server_id: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string[] | null;
  enabled: boolean;
};

function stubConnectedServers(rows: McpRow[]) {
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ data: rows, error: null }),
        }),
      }),
    }),
  });
}

function internalRow(server_id: string): McpRow {
  return {
    tenant_id: "t-blindness",
    server_id,
    transport: "internal",
    url: null,
    command: null,
    args: null,
    enabled: true,
  };
}

beforeEach(() => {
  _clearToolCacheForTests();
});

const OPERATOR_AGENT_MD = readFileSync(
  join(__dirname, "../../../agents/operator/agent.md"),
  "utf-8",
);

describe("operator connector-blindness — discovery contract (no connected connector is reported disconnected)", () => {
  it("a CONNECTED meta_ads connector does NOT appear in disconnected_connectors", async () => {
    stubConnectedServers([internalRow("meta_ads")]);
    const res = await discoverToolsForTenant("t-blindness", [
      "meta_ads__list_campaigns",
    ]);
    expect(res.tools.map((t) => t.name)).toContain("meta_ads__list_campaigns");
    expect(res.disconnected_connectors).not.toContain("meta_ads");
  });

  it("a CONNECTED slack connector does NOT appear in disconnected_connectors", async () => {
    stubConnectedServers([internalRow("slack")]);
    const res = await discoverToolsForTenant("t-blindness", [
      "slack__list_channels",
    ]);
    expect(res.disconnected_connectors).not.toContain("slack");
  });

  it("only a GENUINELY-disconnected connector reaches disconnected_connectors", async () => {
    stubConnectedServers([internalRow("meta_ads")]);
    const res = await discoverToolsForTenant("t-blindness", [
      "meta_ads__list_campaigns",
      "github__list_repos",
    ]);
    expect(res.disconnected_connectors).not.toContain("meta_ads");
    expect(res.disconnected_connectors).toContain("github");
  });
});

describe("operator read-surface — full reads, zero specialist writes (2026-06-01)", () => {
  const declaredTools = (() => {
    const lines = OPERATOR_AGENT_MD.split("\n");
    const start = lines.findIndex((l) => /^\s{4}tools:\s*$/.test(l));
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i].match(/^\s{6}-\s+([a-z0-9_]+__[a-z0-9_*]+)\s*$/);
      if (m) out.push(m[1]);
      else if (/^\s{4}\S/.test(lines[i])) break;
    }
    return out;
  })();

  it("declares the completed READ surface incl. the 2026-06-01 additions", () => {
    for (const t of [
      "github__read_file",
      "github__search_code",
      "github__list_repos",
      "operator_db__codeact",
      "jira__get_attachment",
      "memory__search",
    ]) {
      expect(declaredTools).toContain(t);
    }
  });

  it("declares NO raw specialist WRITE tool (un-gated in the direct call path)", () => {
    const FORBIDDEN_WRITES = [
      "github__open_pr",
      "github__push_to_main",
      "github__squash_merge",
      "github__close_pr",
      "github__post_review",
      "github__request_changes",
      "github__add_label",
      "jira__create_issue",
      "jira__add_comment",
      "linear__create_issue",
      "linear__add_comment",
      "stripe__create_payment",
      "stripe__remit_to_tenant",
      "stripe__submit_dispute_evidence",
      "slack__post_message",
    ];
    const leaked = FORBIDDEN_WRITES.filter((w) => declaredTools.includes(w));
    expect(leaked).toEqual([]);
  });
});
