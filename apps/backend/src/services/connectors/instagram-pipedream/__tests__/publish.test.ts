
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ proxyRequest: vi.fn() }));
vi.mock("@/services/connectors/pipedream/api", () => ({ proxyRequest: m.proxyRequest, listConnectedAccounts: vi.fn() }));

import { publishInstagramImageViaPipedream, resolveIgUserId } from "../publish";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const urlOf = (call: unknown[]) => new URL((call[0] as { url: string }).url);

beforeEach(() => m.proxyRequest.mockReset());

describe("publishInstagramImageViaPipedream", () => {
  it("resolves the IG user via /me/accounts, creates a captioned container, polls, publishes, reads the permalink", async () => {
    m.proxyRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: { data: [{ name: "Acme", instagram_business_account: { id: "1789" } }] } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: { id: "c1" } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: { status_code: "FINISHED" } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: { id: "m1" } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: { permalink: "https://www.instagram.com/p/abc/" } });
    const r = await publishInstagramImageViaPipedream(TENANT, "apn_1", "hello 👋", "https://signed.example/x.jpg?token=1", { pollDelayMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.raw).toMatchObject({ id: "m1", permalink: "https://www.instagram.com/p/abc/", transport: "pipedream" });
    const calls = m.proxyRequest.mock.calls;
    expect(calls).toHaveLength(5);
    for (const c of calls) expect(c[0]).toMatchObject({ external_user_id: TENANT, app_slug: "instagram_business", account_id: "apn_1" });
    expect(urlOf(calls[0]).pathname).toBe("/v25.0/me/accounts");
    const container = urlOf(calls[1]);
    expect(container.pathname).toBe("/v25.0/1789/media");
    expect(container.searchParams.get("caption")).toBe("hello 👋");
    expect(container.searchParams.get("image_url")).toBe("https://signed.example/x.jpg?token=1");
    expect((calls[1][0] as { method: string }).method).toBe("POST");
    expect(urlOf(calls[3]).pathname).toBe("/v25.0/1789/media_publish");
    expect(urlOf(calls[3]).searchParams.get("creation_id")).toBe("c1");
  });

  it("refuses when no Page has a linked Instagram account", async () => {
    m.proxyRequest.mockResolvedValueOnce({ ok: true, status: 200, json: { data: [{ name: "Acme" }] } });
    const r = await resolveIgUserId({ tenantId: TENANT, accountId: "apn_1" });
    expect(r.ok).toBe(false);
    expect(String((r as unknown as { raw: { error: string } }).raw.error)).toMatch(/connect-instagram-to-page/);
  });

  it("returns ok:false with the vendor status on a container error, never throws", async () => {
    m.proxyRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: { data: [{ instagram_business_account: { id: "1789" } }] } })
      .mockResolvedValueOnce({ ok: false, status: 400, json: { error: { message: "Invalid image" } } });
    const r = await publishInstagramImageViaPipedream(TENANT, "apn_1", "c", "https://s/x.jpg", { pollDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});
