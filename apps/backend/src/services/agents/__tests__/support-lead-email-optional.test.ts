
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

import { getAgentSetupSchema, probeSetupCompleteness } from "../setup-schema";

const SUPPORT_LEAD_META = {
  metadata_praxis: {
    tools: [
      "web_search__search",
      "web_fetch__fetch",
      "apify__rag_web_browser",
      "memory__search",
      "operator_db__catalog",
      "operator_db__query",
      "slack__list_channels",
      "slack__get_channel_history",
      "report__render_pdf",
      "artifacts__list",
      "artifacts__get",
      "github__read_file",
      "github__search_code",
      "github__list_files",
      "product__probe",
      "email__list_inbox",
      "email__get_thread",
    ],
    setup: {
      optional_connectors: ["slack", "operator_db", "github", "email"],
    },
  },
};

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
});

describe("support-lead email connector — optional, not required", () => {
  it("getAgentSetupSchema includes 'email' in optional_connectors", async () => {
    mocks.loadAgent.mockResolvedValueOnce(SUPPORT_LEAD_META);
    const schema = await getAgentSetupSchema("support-lead", "t1");
    expect(schema).not.toBeNull();
    expect(schema!.optional_connectors).toContain("email");
  });

  it("probeSetupCompleteness: email in missing_optional, NOT missing_required, when no connectors connected", async () => {
    mocks.loadAgent.mockResolvedValueOnce(SUPPORT_LEAD_META);
    mocks.connectorMetaSelect.mockResolvedValueOnce({ data: [], error: null });
    const r = await probeSetupCompleteness("t1", "support-lead");
    expect(r.missing_required_connectors).toEqual([]);
    expect(r.missing_optional_connectors).toContain("email");
    expect(r.ok).toBe(true);
  });
});
