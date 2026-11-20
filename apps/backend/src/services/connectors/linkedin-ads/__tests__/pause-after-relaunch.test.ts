import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findBinding: vi.fn(),
  accountBinding: vi.fn(),
  boundPause: vi.fn(),
  unboundPause: vi.fn(),
  read: vi.fn(),
  cardAt: "2026-11-01T10:00:00.000Z" as string | null,
  ops: [] as Array<{ created_at: string; status: string }>,
  queries: [] as Array<{ table: string; filters: Record<string, unknown> }>,
}));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: m.findBinding, getAccountBinding: m.accountBinding }));
vi.mock("@/services/ads-wallet/adapters/linkedin", () => ({ requestLinkedinPause: m.boundPause }));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({ getLinkedInCampaign: m.read }));
vi.mock("@/services/connectors/linkedin-ads/write", () => ({ pauseLinkedInCampaign: m.unboundPause }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      m.queries.push({ table, filters });
      const result = () =>
        table === "channel_actions"
          ? { error: null, data: filters.id === "card-1" && m.cardAt ? { created_at: m.cardAt } : null }
          : { error: null, data: m.ops.filter((o) => (filters.status as string[]).includes(o.status)) };
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (c: string, v: unknown) => ((filters[c] = v), q);
      q.in = (c: string, v: unknown) => ((filters[c] = v), q);
      q.maybeSingle = async () => result();
      q.then = (ok: (v: unknown) => void) => ok(result());
      return q;
    },
  }),
}));

import { executeLinkedInPause } from "../execute-pause";

const body = { campaign_id: "22", account_id: "11", status: "PAUSED", name: "Spring" };

beforeEach(() => {
  for (const f of [m.findBinding, m.accountBinding, m.boundPause, m.unboundPause, m.read]) f.mockReset();
  m.cardAt = "2026-11-01T10:00:00.000Z";
  m.ops = [];
  m.queries = [];
  m.findBinding.mockResolvedValue({ id: "bound-1", account_binding_id: "ab" });
  m.accountBinding.mockResolvedValue({ provider_account_id: "11" });
  m.boundPause.mockResolvedValue("paused");
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
});
afterEach(() => {
  delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
});

describe("Flow 44: an old Zavi pause card approved after the founder relaunched the campaign", () => {
  it("never pauses the relaunched campaign, records no stop, and retires the card with a plain note", async () => {
    m.ops = [
      { created_at: "2026-10-30T09:00:00.000Z", status: "succeeded" },
      { created_at: "2026-11-02T08:00:00.000Z", status: "succeeded" },
    ];
    const r = await executeLinkedInPause({ tenant_id: "t1", body, id: "card-1" });
    expect(m.boundPause).not.toHaveBeenCalled();
    expect(m.unboundPause).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, notice: '"Spring" was launched again after this pause was suggested, so Zavi left it running and did not pause it. Ask Zavi to pause it again if you still want it stopped.' });
    expect(r.notice).not.toMatch(/Campaign Manager|binding|operation/i);
    expect(m.queries.find((q) => q.table === "ads_campaign_operations")?.filters).toMatchObject({ campaign_binding_id: "bound-1", kind: "activate" });
  });

  it("a relaunch still in flight when the card is approved is left alone too", async () => {
    m.ops = [{ created_at: "2026-11-02T08:00:00.000Z", status: "pending" }];
    await executeLinkedInPause({ tenant_id: "t1", body, id: "card-1" });
    expect(m.boundPause).not.toHaveBeenCalled();
  });

  it("a launch from before the card, or one that never reached LinkedIn after it, does not stop the pause", async () => {
    m.ops = [
      { created_at: "2026-10-30T09:00:00.000Z", status: "succeeded" },
      { created_at: "2026-11-02T08:00:00.000Z", status: "refused" },
    ];
    const r = await executeLinkedInPause({ tenant_id: "t1", body, id: "card-1" });
    expect(m.boundPause).toHaveBeenCalledWith("t1", "bound-1");
    expect(r).toEqual({ ok: true, notice: 'Paused "Spring" in LinkedIn Ads.' });
  });

  it("a campaign the founder paused another way and left paused closes as already paused", async () => {
    m.boundPause.mockResolvedValue("already_paused");
    const r = await executeLinkedInPause({ tenant_id: "t1", body, id: "card-1" });
    expect(r).toEqual({ ok: true, notice: '"Spring" was already paused in LinkedIn Ads.' });
  });

  it("when the card's filing time cannot be read, the pause still goes ahead, so a stop is never lost", async () => {
    m.cardAt = null;
    m.ops = [{ created_at: "2026-11-02T08:00:00.000Z", status: "succeeded" }];
    await executeLinkedInPause({ tenant_id: "t1", body, id: "card-1" });
    expect(m.boundPause).toHaveBeenCalledTimes(1);
  });
});
