import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const m = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  getCampaign: vi.fn(),
  pause: vi.fn(),
  record: vi.fn(),
}));

function chain(rows: Array<Record<string, unknown>>) {
  const filters: Array<(r: Record<string, unknown>) => boolean> = [];
  const q: Record<string, unknown> = {
    select: () => q,
    order: () => q,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
    in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
    range: async () => ({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }),
    maybeSingle: async () => ({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
  };
  return q;
}

vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  asTenantId: (t: string) => t,
  globalClient: () => ({ from: (t: string) => chain(m.tables[t] ?? []) }),
  tenantClient: (tenant: string) => ({ from: (t: string) => chain((m.tables[t] ?? []).filter((r) => !("tenant_id" in r) || r.tenant_id === tenant)) }),
}));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: async () => null, getAccountBinding: vi.fn() }));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  getLinkedInCampaign: (...a: unknown[]) => m.getCampaign(...a),
  readLinkedInAdAnalytics: vi.fn(),
  readLinkedInAdAnalyticsWithToken: vi.fn(),
  listLinkedInAdAccounts: vi.fn(),
}));
vi.mock("@/services/connectors/linkedin-ads/write", () => ({ pauseLinkedInCampaign: (...a: unknown[]) => m.pause(...a) }));

import { executeLinkedInPause } from "../execute-pause";
import { linkedinAdsProposePauseCampaignTool, readLinkedInPauseBody } from "@/services/tools/linkedin-ads/propose_pause_campaign";

const card = { campaign_id: "22", account_id: "500", status: "PAUSED", name: "Spring" };

beforeEach(() => {
  m.tables = {
    ads_provider_accounts: [{ platform: "linkedin", provider_account_id: "500", credential_source: "tenant_connector", credential_tenant_id: A, claim_released_at: null }],
    ads_account_binding_details: [{ id: "ab-A", tenant_id: A, platform: "linkedin", provider_account_id: "500", funding_source: "provider" }],
    ads_account_selections: [{ tenant_id: A, platform: "linkedin", account_binding_id: "ab-A" }],
    ads_campaign_binding_details: [],
    ads_account_binding_status: [],
  };
  m.getCampaign.mockReset();
  m.getCampaign.mockResolvedValue({ id: "22", name: "Spring", status: "ACTIVE" });
  m.pause.mockReset();
  m.pause.mockResolvedValue(undefined);
  m.record.mockReset();
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
});
afterEach(() => {
  delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
});

describe("pausing a campaign Zavi has no record of: the workspace must own the ad account", () => {
  it("must-catch: workspace B, whose LinkedIn login also sees A's ad account, cannot pause A's campaign on Approve; LinkedIn is never called", async () => {
    const out = await executeLinkedInPause({ tenant_id: B, body: card, id: "card-b" });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("linkedin_ads_account_not_in_use");
    expect(out.error).not.toMatch(/tenant|workspace_id|binding|500/);
    expect(m.getCampaign).not.toHaveBeenCalled();
    expect(m.pause).not.toHaveBeenCalled();
  });

  it("must-catch: workspace B cannot file a pause card for A's campaign; nothing is read from LinkedIn", async () => {
    await expect(readLinkedInPauseBody(B, { campaign_id: "22", account_id: "500", rationale: "stop it" })).rejects.toMatchObject({ code: "linkedin_ads_account_not_in_use" });
    const emit = vi.fn();
    await expect(
      linkedinAdsProposePauseCampaignTool.execute({ tenant_id: B, emit_decision: emit, log: () => undefined } as never, { campaign_id: "22", account_id: "500", rationale: "stop it" }),
    ).rejects.toMatchObject({ code: "linkedin_ads_account_not_in_use" });
    expect(emit).not.toHaveBeenCalled();
    expect(m.getCampaign).not.toHaveBeenCalled();
  });

  it("must-not-touch: workspace A, which uses the account, still pauses it", async () => {
    const out = await executeLinkedInPause({ tenant_id: A, body: card, id: "card-a" });
    expect(out).toMatchObject({ ok: true });
    expect(m.pause).toHaveBeenCalledWith(A, "500", "22");
    expect(await readLinkedInPauseBody(A, { campaign_id: "22", account_id: "500", rationale: "stop it" })).toMatchObject({ campaign_id: "22", account_id: "500", status: "PAUSED" });
  });

  it("an ownership read that fails refuses the pause instead of guessing, and LinkedIn is never called", async () => {
    m.tables.ads_account_binding_details = Array.from({ length: 1000 }, (_, i) => ({ id: `x${i}`, tenant_id: A, platform: "linkedin", provider_account_id: String(i), funding_source: "provider" }));
    const out = await executeLinkedInPause({ tenant_id: A, body: card, id: "card-a" });
    expect(out).toMatchObject({ ok: false, code: "ads_binding_unavailable" });
    expect(m.pause).not.toHaveBeenCalled();
    expect(m.getCampaign).not.toHaveBeenCalled();
  });
});

describe("a replaced or stopped ad account can still be paused, never anything else", () => {
  const OLD = "ab-A-old";
  beforeEach(() => {
    m.tables.ads_account_binding_details = [
      { id: OLD, tenant_id: A, platform: "linkedin", provider_account_id: "500", funding_source: "provider", credential_tenant_id: A },
      { id: "ab-A-new", tenant_id: A, platform: "linkedin", provider_account_id: "600", funding_source: "provider", credential_tenant_id: A },
    ];
    m.tables.ads_account_selections = [{ tenant_id: A, platform: "linkedin", account_binding_id: "ab-A-new" }];
    m.tables.ads_account_binding_status = [{ account_binding_id: OLD, disabled_at: "2026-11-05T00:00:00Z" }];
    m.tables.ads_campaign_binding_details = [{ tenant_id: A, platform: "linkedin", funding_source: "provider", account_binding_id: OLD, provider_campaign_id: "22" }];
  });

  it("must-catch: an approved pause for a campaign on the account Zavi stopped using still pauses it, so nothing keeps spending", async () => {
    const out = await executeLinkedInPause({ tenant_id: A, body: card, id: "card-a" });
    expect(out).toMatchObject({ ok: true });
    expect(m.pause).toHaveBeenCalledWith(A, "500", "22");
  });

  it("must-catch: workspace B still cannot pause it, and A cannot pause on an old account that never held a Zavi campaign", async () => {
    const b = await executeLinkedInPause({ tenant_id: B, body: card, id: "card-b" });
    expect(b).toMatchObject({ ok: false, code: "linkedin_ads_account_not_in_use" });
    m.tables.ads_campaign_binding_details = [];
    const a = await executeLinkedInPause({ tenant_id: A, body: card, id: "card-a" });
    expect(a).toMatchObject({ ok: false, code: "linkedin_ads_account_not_in_use" });
    expect(m.pause).not.toHaveBeenCalled();
  });

  it("must-catch: a new pause card cannot be filed on the old account; only the account in use proposes", async () => {
    await expect(readLinkedInPauseBody(A, { campaign_id: "22", account_id: "500", rationale: "stop it" })).rejects.toMatchObject({ code: "linkedin_ads_account_not_in_use" });
  });
});
