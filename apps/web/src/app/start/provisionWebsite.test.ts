import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("./websiteRequest", () => ({ websitePost: h.post, WebsiteSessionExpired: class extends Error {} }));
vi.mock("@/lib/consent", () => ({ hasAnalyticsConsent: () => false }));
vi.mock("@/lib/analytics/affiliate", () => ({ withAffiliateClick: (body: object) => body }));
import { provisionWebsite } from "./provisionWebsite";
import { urlAttribution, withUrlAttribution } from "@/lib/marketing/liveFrom";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("provisionWebsite", () => {
  beforeEach(() => {
    h.post.mockReset();
    h.post.mockImplementation(async () => json({ tenant_id: "t1" }));
  });

  it.each([
    ["x", "social", undefined],
    ["x", "creator", "creator_alex"],
    ["email", "email", undefined],
    ["linkedin", "social", undefined],
    ["producthunt", "referral", undefined],
  ])("sends the %s/%s launch link's tags to activate when analytics is declined", async (source, medium, creator) => {
    const params = new URLSearchParams({ utm_source: source!, utm_medium: medium!, utm_campaign: "launch2" });
    if (creator) params.set("utm_content", creator);
    const loginNext = withUrlAttribution("/onboarding/past-work?website=example.com", urlAttribution(params));
    const resumed = new URL(loginNext, "https://www.zaviagent.com").searchParams;
    await provisionWebsite("example.com", false, urlAttribution(resumed));
    expect(h.post.mock.calls[0][1].attribution).toEqual(Object.fromEntries(params));
  });

  it("never generates memory: activates once with background memory and the scan id", async () => {
    await expect(provisionWebsite("bloom-studio.com", false, {}, undefined, "scan-1")).resolves.toBe("t1");
    expect(h.post.mock.calls.map((c) => c[0])).toEqual(["/api/onboarding/activate"]);
    const activation = h.post.mock.calls[0][1];
    expect(activation).toMatchObject({
      slug: "bloom-studio",
      display_name: "Bloom Studio",
      memory: {},
      background_memory: true,
      scan_id: "scan-1",
      onboarding_meta: { wizard: { orgName: "Bloom Studio", website: "bloom-studio.com" } },
      additional: false,
    });
    expect(activation.onboarding_meta.wizard).not.toHaveProperty("marketplaceShape");
    expect(activation.onboarding_meta.wizard).not.toHaveProperty("stage");
  });

  it("sends no scan id when the link had none", async () => {
    await provisionWebsite("bloom.com", true, {});
    const activation = h.post.mock.calls[0][1];
    expect(activation).not.toHaveProperty("scan_id");
    expect(activation).toMatchObject({ background_memory: true, additional: true });
  });

  it("sends the browser's time zone so the workspace runs on the founder's clock", async () => {
    const zone = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "Europe/Paris",
    } as Intl.ResolvedDateTimeFormatOptions);
    await provisionWebsite("bloom.com", false, {});
    zone.mockRestore();
    expect(h.post.mock.calls[0][1].timezone).toBe("Europe/Paris");
  });

  it("names the workspace after the host when no name can be guessed from it", async () => {
    await provisionWebsite("facebook.com", false, {});
    expect(h.post.mock.calls[0][1].display_name).toBe("facebook.com");
  });

  it("sends the intent's Idempotency-Key, and the 5xx retry sends the same one", async () => {
    h.post.mockImplementationOnce(async () => json({}, 502));
    await expect(provisionWebsite("bloom.com", true, {}, () => "intent-key-1")).resolves.toBe("t1");
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.post.mock.calls.map((c) => c[3])).toEqual([{ "Idempotency-Key": "intent-key-1" }, { "Idempotency-Key": "intent-key-1" }]);
  });

  it("retries once on a server error, then reports the backend's limit message", async () => {
    h.post.mockImplementation(async () => json({}, 502));
    await expect(provisionWebsite("bloom.com", false, {})).rejects.toThrow("Couldn't set up your workspace");
    expect(h.post).toHaveBeenCalledTimes(2);
    h.post.mockReset();
    h.post.mockImplementation(async () => json({ error: { code: "workspace_limit", message: "Try again in an hour." } }, 429));
    await expect(provisionWebsite("bloom.com", false, {})).rejects.toThrow("Try again in an hour.");
  });
});
