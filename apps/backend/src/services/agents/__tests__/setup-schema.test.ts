import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  loadAgent: vi.fn(),
  getSecret: vi.fn(),
  connectorMetaSelect: vi.fn(),
  setupStateUpsert: vi.fn(),
  setupStateDelete: vi.fn(),
}));

vi.mock("@/services/agents/registry", () => ({
  loadAgentDefinition: mocks.loadAgent,
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: mocks.getSecret }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (t: string) => {
      if (t === "connector_metadata") {
        return {
          select: () => ({
            eq: () => ({ in: mocks.connectorMetaSelect }),
          }),
        };
      }
      if (t === "agent_setup_state") {
        return {
          upsert: mocks.setupStateUpsert,
          delete: () => ({ eq: () => ({ eq: mocks.setupStateDelete }) }),
        };
      }
      throw new Error(`unexpected table ${t}`);
    },
  }),
}));

import {
  getAgentSetupSchema,
  probeSetupCompleteness,
  recordSetupBlock,
} from "../setup-schema";

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
});

describe("getAgentSetupSchema — connector auto-derive + explicit union", () => {
  it("derives github from github__* tools", async () => {
    mocks.loadAgent.mockResolvedValueOnce({
      metadata_praxis: { tools: ["github__list_repos", "memory__search"] },
    });
    const s = await getAgentSetupSchema("x", "t1");
    expect(s?.connectors).toEqual(["github"]);
  });

  it("derives multiple + dedups", async () => {
    mocks.loadAgent.mockResolvedValueOnce({
      metadata_praxis: {
        tools: [
          "slack__list_channels",
          "slack__get_channel_history",
          "stripe__list_charges",
        ],
      },
    });
    const s = await getAgentSetupSchema("x", "t1");
    expect(s?.connectors).toEqual(["slack", "stripe"]);
  });

  it("ignores unknown prefixes (platform-internal)", async () => {
    mocks.loadAgent.mockResolvedValueOnce({
      metadata_praxis: { tools: ["memory__search", "web_search__search"] },
    });
    const s = await getAgentSetupSchema("x", "t1");
    expect(s?.connectors).toEqual([]);
  });

  it("unions explicit setup.connectors with auto-derived (qa-engineer-weekly case)", async () => {
    mocks.loadAgent.mockResolvedValueOnce({
      metadata_praxis: {
        tools: ["qa_engineer__list_active_tests", "browser_nav"],
        setup: { connectors: ["github"], vault_keys: [], rationale: "" },
      },
    });
    const s = await getAgentSetupSchema("qa-engineer-weekly", "t1");
    expect(s?.connectors).toEqual(["github"]);
  });

  it("returns vault_keys + rationale from frontmatter", async () => {
    mocks.loadAgent.mockResolvedValueOnce({
      metadata_praxis: {
        tools: [],
        setup: {
          rationale: "needs creds",
          vault_keys: [
            {
              key: "qa.staging_url",
              label: "URL",
              input: "url",
              required: true,
            },
          ],
        },
      },
    });
    const s = await getAgentSetupSchema("x", "t1");
    expect(s?.rationale).toBe("needs creds");
    expect(s?.vault_keys).toHaveLength(1);
  });

  it("returns null for unknown agent", async () => {
    mocks.loadAgent.mockResolvedValueOnce(null);
    const s = await getAgentSetupSchema("nope", "t1");
    expect(s).toBeNull();
  });
});

describe("probeSetupCompleteness", () => {
  it("ok when all required vault keys present + connectors connected", async () => {
    mocks.loadAgent.mockResolvedValueOnce({
      metadata_praxis: {
        tools: ["github__list_repos"],
        setup: {
          rationale: "",
          vault_keys: [
            { key: "qa.staging_url", label: "x", input: "url", required: true },
          ],
        },
      },
    });
    mocks.getSecret.mockResolvedValueOnce("https://staging.example.com");
    mocks.connectorMetaSelect.mockResolvedValueOnce({
      data: [{ slug: "github" }],
      error: null,
    });
    const r = await probeSetupCompleteness("t1", "x");
    expect(r.ok).toBe(true);
  });

  it("flags missing required vault key (null secret)", async () => {
    mocks.loadAgent.mockResolvedValueOnce({
      metadata_praxis: {
        tools: [],
        setup: {
          rationale: "",
          vault_keys: [
            { key: "qa.staging_url", label: "x", input: "url", required: true },
            { key: "qa.host.email", label: "y", input: "email", required: false },
          ],
        },
      },
    });
    mocks.getSecret.mockResolvedValue(null);
    const r = await probeSetupCompleteness("t1", "x");
    expect(r.ok).toBe(false);
    expect(r.missing_vault_keys).toEqual(["qa.staging_url"]);
    expect(r.missing_vault_keys).not.toContain("qa.host.email");
  });

  it("flags missing connector", async () => {
    mocks.loadAgent.mockResolvedValueOnce({
      metadata_praxis: { tools: ["github__list_repos"] },
    });
    mocks.connectorMetaSelect.mockResolvedValueOnce({ data: [], error: null });
    const r = await probeSetupCompleteness("t1", "x");
    expect(r.ok).toBe(false);
    expect(r.missing_connectors).toEqual(["github"]);
  });

  it("a Composio-rail row satisfies its ads slug (composio.tiktok_ads -> tiktok_ads)", async () => {
    mocks.loadAgent.mockResolvedValueOnce({ metadata_praxis: { tools: ["tiktok_ads__list_campaigns"] } });
    mocks.connectorMetaSelect.mockImplementationOnce(async (_col: string, slugs: string[]) => {
      expect(slugs).toEqual(expect.arrayContaining(["tiktok_ads", "composio.tiktok_ads"]));
      return { data: [{ slug: "composio.tiktok_ads" }], error: null };
    });
    const r = await probeSetupCompleteness("t1", "x");
    expect(r.missing_connectors).toEqual([]);
  });

  it("treats connector probe error as fail-closed", async () => {
    mocks.loadAgent.mockResolvedValueOnce({
      metadata_praxis: { tools: ["github__list_repos"] },
    });
    mocks.connectorMetaSelect.mockResolvedValueOnce({
      data: null,
      error: { message: "db down" },
    });
    const r = await probeSetupCompleteness("t1", "x");
    expect(r.ok).toBe(false);
    expect(r.missing_connectors).toEqual(["github"]);
  });

  it("ok when agent has no setup declaration", async () => {
    mocks.loadAgent.mockResolvedValueOnce({
      metadata_praxis: { tools: [] },
    });
    const r = await probeSetupCompleteness("t1", "x");
    expect(r.ok).toBe(true);
  });

  it("does NOT block an advisory agent when github is OPTIONAL and unconnected", async () => {
    mocks.loadAgent.mockResolvedValueOnce({
      metadata_praxis: {
        tools: [
          "memory__search",
          "github__read_file",
          "github__search_code",
          "github__list_files",
          "product__probe",
        ],
        setup: { optional_connectors: ["github"] },
      },
    });
    mocks.connectorMetaSelect.mockResolvedValueOnce({ data: [], error: null });
    const r = await probeSetupCompleteness("t1", "growth-lead");
    expect(r.ok).toBe(true);
    expect(r.missing_optional_connectors).toEqual(["github"]);
    expect(r.missing_required_connectors).toEqual([]);
  });

  it("keeps optional github out of missing_required even when the connector probe errors", async () => {
    mocks.loadAgent.mockResolvedValueOnce({
      metadata_praxis: {
        tools: ["github__read_file", "product__probe"],
        setup: { optional_connectors: ["github"] },
      },
    });
    mocks.connectorMetaSelect.mockResolvedValueOnce({
      data: null,
      error: { message: "db down" },
    });
    const r = await probeSetupCompleteness("t1", "growth-lead");
    expect(r.missing_required_connectors).toEqual([]);
    expect(r.missing_optional_connectors).toEqual(["github"]);
  });

  it("returns ok when agent unknown (load returns null)", async () => {
    mocks.loadAgent.mockResolvedValueOnce(null);
    const r = await probeSetupCompleteness("t1", "missing");
    expect(r.ok).toBe(true);
  });
});

describe("recordSetupBlock", () => {
  it("upserts agent_setup_state with blocked_run_id when probe fails", async () => {
    mocks.setupStateUpsert.mockResolvedValueOnce({ error: null });
    await recordSetupBlock(
      "t1",
      "x",
      {
        ok: false,
        missing_vault_keys: ["qa.staging_url"],
        missing_connectors: [],
        missing_required_connectors: [],
        missing_optional_connectors: [],
      },
      "run-blocked-1",
    );
    expect(mocks.setupStateUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "t1",
        agent_slug: "x",
        missing_vault_keys: ["qa.staging_url"],
        blocked_run_id: "run-blocked-1",
      }),
      expect.objectContaining({ onConflict: "tenant_id,agent_slug" }),
    );
  });

  it("clears row when probe ok (blocked_run_id ignored)", async () => {
    mocks.setupStateDelete.mockResolvedValueOnce({ error: null });
    await recordSetupBlock(
      "t1",
      "x",
      {
        ok: true,
        missing_vault_keys: [],
        missing_connectors: [],
        missing_required_connectors: [],
        missing_optional_connectors: [],
      },
      "run-blocked-2",
    );
    expect(mocks.setupStateDelete).toHaveBeenCalled();
    expect(mocks.setupStateUpsert).not.toHaveBeenCalled();
  });
});
