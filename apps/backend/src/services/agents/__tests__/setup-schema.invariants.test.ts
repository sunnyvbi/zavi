
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  loadAgent: vi.fn(),
  getSecret: vi.fn(),
  connectorMetaSelect: vi.fn(),
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
      throw new Error(`unexpected table ${t}`);
    },
  }),
}));

import {
  getAgentSetupSchema,
  probeSetupCompleteness,
} from "../setup-schema";

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
});

describe("Invariant: probeSetupCompleteness — required-only-met → ok:true", () => {
  it("blocks nothing when all required connectors are connected", async () => {
    mocks.loadAgent.mockResolvedValue({
      metadata_praxis: {
        tools: ["github__list_repos"],
        setup: { connectors: ["jira"], optional_connectors: [] },
      },
    });
    mocks.connectorMetaSelect.mockResolvedValue({
      data: [{ slug: "github" }, { slug: "jira" }],
      error: null,
    });
    const r = await probeSetupCompleteness("t1", "agent-a");
    expect(r.ok).toBe(true);
    expect(r.missing_connectors).toEqual([]);
    expect(r.missing_required_connectors).toEqual([]);
    expect(r.missing_optional_connectors).toEqual([]);
  });
});

describe("Invariant: probeSetupCompleteness — required-only-missing → ok:false", () => {
  it("blocks when any required connector is missing", async () => {
    mocks.loadAgent.mockResolvedValue({
      metadata_praxis: {
        tools: ["github__list_repos", "jira__list_issues"],
        setup: { optional_connectors: [] },
      },
    });
    mocks.connectorMetaSelect.mockResolvedValue({
      data: [{ slug: "github" }],
      error: null,
    });
    const r = await probeSetupCompleteness("t1", "agent-a");
    expect(r.ok).toBe(false);
    expect(r.missing_required_connectors).toEqual(["jira"]);
    expect(r.missing_optional_connectors).toEqual([]);
    expect(r.missing_connectors).toEqual(["jira"]);
  });
});

describe("Invariant: probeSetupCompleteness — optional-only-missing → ok:true (BUG-2 fix)", () => {
  it("does NOT block when only an OPTIONAL connector is missing", async () => {
    mocks.loadAgent.mockResolvedValue({
      metadata_praxis: {
        tools: ["slack__list_channels"],
        setup: { optional_connectors: ["slack"] },
      },
    });
    mocks.connectorMetaSelect.mockResolvedValue({ data: [], error: null });
    const r = await probeSetupCompleteness("t1", "agent-a");
    expect(r.ok).toBe(true);
    expect(r.missing_required_connectors).toEqual([]);
    expect(r.missing_optional_connectors).toEqual(["slack"]);
    expect(r.missing_connectors).toEqual(["slack"]);
  });
});

describe("Invariant: probeSetupCompleteness — mixed-only-optional-missing → ok:true", () => {
  it("clears when required is connected and only optional is missing", async () => {
    mocks.loadAgent.mockResolvedValue({
      metadata_praxis: {
        tools: ["github__list_repos", "slack__list_channels"],
        setup: { optional_connectors: ["slack"] },
      },
    });
    mocks.connectorMetaSelect.mockResolvedValue({
      data: [{ slug: "github" }],
      error: null,
    });
    const r = await probeSetupCompleteness("t1", "agent-a");
    expect(r.ok).toBe(true);
    expect(r.missing_required_connectors).toEqual([]);
    expect(r.missing_optional_connectors).toEqual(["slack"]);
  });
});

describe("Invariant: probeSetupCompleteness — mixed-only-required-missing → ok:false", () => {
  it("blocks when only required is missing; optional surfaced separately", async () => {
    mocks.loadAgent.mockResolvedValue({
      metadata_praxis: {
        tools: ["github__list_repos", "slack__list_channels"],
        setup: { optional_connectors: ["slack"] },
      },
    });
    mocks.connectorMetaSelect.mockResolvedValue({
      data: [{ slug: "slack" }],
      error: null,
    });
    const r = await probeSetupCompleteness("t1", "agent-a");
    expect(r.ok).toBe(false);
    expect(r.missing_required_connectors).toEqual(["github"]);
    expect(r.missing_optional_connectors).toEqual([]);
  });
});

describe("Invariant: probeSetupCompleteness — performance-marketer shape", () => {
  it("reports google_ads + meta_ads as required-missing, slack as optional-missing", async () => {
    mocks.loadAgent.mockResolvedValue({
      metadata_praxis: {
        tools: [
          "memory__search",
          "slack__list_channels",
          "slack__get_channel_history",
          "google_ads__list_campaigns",
          "meta_ads__list_campaigns",
        ],
        setup: { optional_connectors: ["slack"] },
      },
    });
    mocks.connectorMetaSelect.mockResolvedValue({ data: [], error: null });
    const r = await probeSetupCompleteness("t1", "performance-marketer");
    expect(r.ok).toBe(false);
    expect(r.missing_required_connectors.sort()).toEqual([
      "google_ads",
      "meta_ads",
    ]);
    expect(r.missing_optional_connectors).toEqual(["slack"]);
  });
});

describe("Invariant: probeSetupCompleteness — empty-vault-blocked-conn (BUG-1 regression)", () => {
  it("must STILL be ok:false when agent has 0 required vault keys but missing required connectors", async () => {
    mocks.loadAgent.mockResolvedValue({
      metadata_praxis: {
        tools: ["github__list_repos"],
        setup: {
          vault_keys: [],
          optional_connectors: [],
        },
      },
    });
    mocks.connectorMetaSelect.mockResolvedValue({ data: [], error: null });
    const r = await probeSetupCompleteness("t1", "connector-only-agent");
    expect(r.ok).toBe(false);
    expect(r.missing_required_connectors).toEqual(["github"]);
    expect(r.missing_vault_keys).toEqual([]);
  });
});

describe("Invariant: probeSetupCompleteness — no setup block on agent", () => {
  it("returns ok:true when agent has no setup declaration at all", async () => {
    mocks.loadAgent.mockResolvedValue({
      metadata_praxis: { tools: [] },
    });
    const r = await probeSetupCompleteness("t1", "agent-x");
    expect(r.ok).toBe(true);
    expect(r.missing_required_connectors).toEqual([]);
    expect(r.missing_optional_connectors).toEqual([]);
  });
});

describe("Invariant: probeSetupCompleteness — fail-closed on supabase error", () => {
  it("treats probe failure as missing AND respects optional split", async () => {
    mocks.loadAgent.mockResolvedValue({
      metadata_praxis: {
        tools: ["github__list_repos", "slack__list_channels"],
        setup: { optional_connectors: ["slack"] },
      },
    });
    mocks.connectorMetaSelect.mockResolvedValue({
      data: null,
      error: { message: "transient db error" },
    });
    const r = await probeSetupCompleteness("t1", "agent-a");
    expect(r.ok).toBe(false);
    expect(r.missing_required_connectors).toEqual(["github"]);
    expect(r.missing_optional_connectors).toEqual(["slack"]);
  });
});

describe("Invariant: getAgentSetupSchema — surfaces optional_connectors", () => {
  it("preserves explicitly-declared optional_connectors even if not auto-derived", async () => {
    mocks.loadAgent.mockResolvedValue({
      metadata_praxis: {
        tools: ["github__list_repos", "slack__list_channels"],
        setup: { optional_connectors: ["slack", "jira"] },
      },
    });
    const s = await getAgentSetupSchema("agent-a", "t1");
    expect(s?.optional_connectors.sort()).toEqual(["jira", "slack"]);
    expect(s?.connectors.sort()).toEqual(["github", "jira", "slack"]);
  });

  it("defaults optional_connectors to [] when not declared", async () => {
    mocks.loadAgent.mockResolvedValue({
      metadata_praxis: { tools: ["github__list_repos"] },
    });
    const s = await getAgentSetupSchema("agent-a", "t1");
    expect(s?.optional_connectors).toEqual([]);
  });
});

describe("Invariant: canSave gate (BUG-1)", () => {
  function canSave(
    requiredVaultKeys: { key: string; required: boolean }[],
    values: Record<string, string>,
    missing_required_connectors: string[],
  ): boolean {
    const allRequiredFilled = requiredVaultKeys
      .filter((v) => v.required)
      .every((v) => (values[v.key] ?? "").trim().length > 0);
    return allRequiredFilled && missing_required_connectors.length === 0;
  }

  it("empty-array trap — required vault empty AND connectors missing → canSave=false", () => {
    expect(canSave([], {}, ["github"])).toBe(false);
  });

  it("required vault filled + no missing connectors → canSave=true", () => {
    expect(
      canSave(
        [{ key: "x", required: true }],
        { x: "value" },
        [],
      ),
    ).toBe(true);
  });

  it("required vault filled + missing required connector → canSave=false", () => {
    expect(
      canSave(
        [{ key: "x", required: true }],
        { x: "value" },
        ["github"],
      ),
    ).toBe(false);
  });

  it("required vault EMPTY + no missing connectors → canSave=false (vault gate)", () => {
    expect(
      canSave(
        [{ key: "x", required: true }],
        {},
        [],
      ),
    ).toBe(false);
  });

  it("all-optional vault + no missing connectors → canSave=true (no required to fail)", () => {
    expect(
      canSave(
        [{ key: "x", required: false }],
        {},
        [],
      ),
    ).toBe(true);
  });
});
