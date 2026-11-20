import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  send: vi.fn(async (_e: unknown) => ({ ids: ["e1"] })),
  notify: vi.fn(async (_i: unknown) => ({ written: true, emailed: true })),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: m.send } }));
vi.mock("../notify", () => ({ notify: m.notify }));
vi.mock("@/services/tenant-client", () => ({ globalClient: () => ({}), selfAccountClient: () => ({}) }));
vi.mock("@/services/humans/store", () => ({ writeWithFreshSlug: vi.fn(), swapMemberHandles: vi.fn() }));
vi.mock("@/services/affiliates/store", () => ({ codeFor: vi.fn(async () => "k7m4p2qa") }));

import { sendCountryNeededIfMissing, sendCreatorLive } from "../creator-setup";

const ID = "11111111-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.stubEnv("WEB_BASE_URL", "https://www.zaviagent.com");
  m.send.mockClear();
  m.notify.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("sendCreatorLive arms the country reminder", () => {
  it.each(["https://latest.zaviagent.com", "http://localhost:3301"])("keeps affiliate notification links on %s", async (base) => {
    vi.stubEnv("WEB_BASE_URL", base);
    await sendCreatorLive(ID, false, "affiliate");
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({
      vars: expect.objectContaining({ affiliate_link: `${base}/?via=k7m4p2qa` }),
    }));
  });
  it("arms it when the creator went live with no country", async () => {
    await sendCreatorLive(ID, true);
    expect(m.send).toHaveBeenCalledWith({ name: "creator/setup.country_check", data: { human_member_id: ID } });
  });

  it("does not arm it when the creator already has a country", async () => {
    await sendCreatorLive(ID, false);
    expect(m.send.mock.calls.map((c) => (c[0] as { name: string }).name)).not.toContain("creator/setup.country_check");
  });

  it("queues the one niche illustration on going live, keyed on the member", async () => {
    await sendCreatorLive(ID, false);
    expect(m.send).toHaveBeenCalledWith({
      id: `creator-illustration-${ID}`,
      name: "creator/illustration.generate",
      data: { human_member_id: ID },
    });
  });

  it("a failed illustration queue does not fail going live or skip the country reminder", async () => {
    m.send.mockRejectedValueOnce(new Error("inngest down"));
    await expect(sendCreatorLive(ID, true)).resolves.toBeUndefined();
    expect(m.send).toHaveBeenCalledWith({ name: "creator/setup.country_check", data: { human_member_id: ID } });
  });

  it("affiliate only: the link email, and no 'so businesses can book you' reminder", async () => {
    await sendCreatorLive(ID, true, "affiliate");
    expect(m.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "creator_live",
        vars: { affiliate_only: true, affiliate_link: "https://www.zaviagent.com/?via=k7m4p2qa", link_path: "/creator/affiliate" },
      }),
    );
    expect(m.send.mock.calls.map((c) => (c[0] as { name: string }).name)).not.toContain("creator/setup.country_check");
  });

  it("both gets the bookings email with the link, and the country reminder", async () => {
    await sendCreatorLive(ID, true, "both");
    expect(m.notify).toHaveBeenCalledWith(
      expect.objectContaining({ vars: { country_missing: true, affiliate_link: "https://www.zaviagent.com/?via=k7m4p2qa" } }),
    );
    expect(m.send).toHaveBeenCalledWith({ name: "creator/setup.country_check", data: { human_member_id: ID } });
  });

  it("a failed arm does not fail going live", async () => {
    m.send.mockRejectedValueOnce(new Error("inngest down"));
    await expect(sendCreatorLive(ID, true)).resolves.toBeUndefined();
  });
});

describe("sendCountryNeededIfMissing", () => {
  it("emails the creator once-keyed on the member when the country is still empty", async () => {
    const res = await sendCountryNeededIfMissing(ID, async () => ({ country_code: null, vetting_state: "approved" }));
    expect(res).toBe("sent");
    expect(m.notify).toHaveBeenCalledWith({
      recipient: { kind: "creator", human_member_id: ID },
      event: "country_needed",
      scope_id: ID,
    });
  });

  it.each([
    ["added a payable country", { country_code: "US", vetting_state: "approved" }],
    ["added a country Zavi cannot pay (the banner already said so)", { country_code: "IN", vetting_state: "approved" }],
    ["was rejected since", { country_code: null, vetting_state: "rejected" }],
  ])("sends nothing when the creator %s", async (_label, state) => {
    expect(await sendCountryNeededIfMissing(ID, async () => state)).toBe("not_needed");
    expect(m.notify).not.toHaveBeenCalled();
  });

  it("sends nothing for a member that no longer exists", async () => {
    expect(await sendCountryNeededIfMissing(ID, async () => null)).toBe("not_needed");
    expect(m.notify).not.toHaveBeenCalled();
  });
});
