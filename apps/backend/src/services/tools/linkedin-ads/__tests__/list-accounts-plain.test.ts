import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ accounts: [] as unknown[], linkedinCalls: 0, own: null as null | ((listed: Array<{ id: string }>) => unknown[]) }));
vi.mock("@/services/tools/linkedin-ads/_wallet", async (orig) => ({ ...(await orig<Record<string, unknown>>()), linkedinWalletGroups: async () => [], linkedinAccountAccess: async () => ({ kind: "own" }) }));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  listLinkedInAdAccounts: vi.fn(async () => (h.linkedinCalls++, h.accounts)),
}));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", () => ({
  ownLinkedinAccounts: vi.fn(async (_t: string, listed: Array<{ id: string }>) => (h.own ? h.own(listed) : listed)),
}));

import { linkedinAdsListAccountsTool, plainAccountStatus } from "../list_accounts";
import { ownLinkedinAccounts } from "@/services/connectors/linkedin-ads/own-accounts";

const ctx = { tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204" } as never;

describe("linkedin_ads_list_accounts output", () => {
  it("gives the model the account's name first and its status in plain words, never the API status code", async () => {
    h.accounts = [
      { id: "559880687", name: "Developer's Ad Account", currency: "USD", status: "ACTIVE" },
      { id: "600000001", name: "Old Account", currency: "EUR", status: "CANCELED" },
      { id: "600000002", name: "New Account", currency: "USD", status: "PENDING_DELETION" },
    ];
    const out = (await linkedinAdsListAccountsTool.execute(ctx, {})) as { count: number; accounts: Array<Record<string, unknown>> };
    expect(out.count).toBe(3);
    expect(Object.keys(out.accounts[0])[0]).toBe("name");
    expect(out.accounts.map((a) => a.status)).toEqual(["open", "closed", "being deleted"]);
    expect(out.accounts[0]).toMatchObject({ name: "Developer's Ad Account", id: "559880687", currency: "USD" });
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/ACTIVE|CANCELED|PENDING_DELETION/);
  });

  it("lists only the accounts the dashboard shows, with one LinkedIn read", async () => {
    h.linkedinCalls = 0;
    h.accounts = [
      { id: "1", name: "Mine", currency: "USD", status: "ACTIVE" },
      { id: "2", name: "Other workspace", currency: "USD", status: "ACTIVE" },
      { id: "3", name: "Stopped", currency: "USD", status: "ACTIVE" },
    ];
    h.own = (listed) => listed.filter((a) => a.id === "1");
    const out = (await linkedinAdsListAccountsTool.execute(ctx, {})) as { count: number; accounts: Array<{ id: string }>; note?: string };
    h.own = null;
    expect(vi.mocked(ownLinkedinAccounts)).toHaveBeenLastCalledWith("73db45ff-457e-4541-bc8f-bdb625390204", h.accounts);
    expect(out.count).toBe(1);
    expect(out.accounts.map((a) => a.id)).toEqual(["1"]);
    expect(JSON.stringify(out)).not.toMatch(/Other workspace|Stopped/);
    expect(h.linkedinCalls).toBe(1);
  });

  it("says no account is in use yet when the login sees accounts but the workspace uses none", async () => {
    h.accounts = [{ id: "2", name: "Other workspace", currency: "USD", status: "ACTIVE" }];
    h.own = () => [];
    const out = (await linkedinAdsListAccountsTool.execute(ctx, {})) as { count: number; note?: string };
    h.own = null;
    expect(out.count).toBe(0);
    expect(out.note).toMatch(/No ad account is in use in this workspace yet/);
  });

  it("an unknown status reads as lowercase words and a missing one stays null", () => {
    expect(plainAccountStatus("ON_HOLD")).toBe("on hold");
    expect(plainAccountStatus(null)).toBeNull();
    expect(plainAccountStatus("draft")).toBe("not set up yet");
  });
});
