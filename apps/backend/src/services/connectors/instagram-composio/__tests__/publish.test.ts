import { describe, it, expect, vi, beforeEach } from "vitest";
const proxy = vi.hoisted(() => vi.fn());
vi.mock("@/services/connectors/composio/api", () => ({ composioProxy: proxy }));
import { publishInstagramImageViaComposio } from "../publish";

const acct = { tenant_id: "T1", toolkit: "instagram", connected_account_id: "ca_1" } as any;
beforeEach(() => proxy.mockReset());

describe("publishInstagramImageViaComposio", () => {
  it("me → container(with caption) → poll → publish → permalink, all on the given account", async () => {
    proxy
      .mockResolvedValueOnce({ ok: true, status: 200, json: { user_id: "IG1" } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: { id: "C1" } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: { status_code: "FINISHED" } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: { id: "M1" } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: { permalink: "https://instagram.com/p/x" } });
    const r = await publishInstagramImageViaComposio(acct, "hi there", "https://signed/x.jpg", { pollDelayMs: 0 });
    expect(r).toEqual({ ok: true, status: 200, raw: { id: "M1", permalink: "https://instagram.com/p/x" } });
    for (const c of proxy.mock.calls) {
      expect(c[0].account).toBe(acct);
      expect(new URL(c[0].endpoint).hostname).toBe("graph.instagram.com");
    }
    expect(proxy.mock.calls[1][0].endpoint).toContain("/IG1/media?");
    expect(proxy.mock.calls[1][0].endpoint).toContain("caption=hi+there");
    expect(proxy.mock.calls[3][0].endpoint).toContain("/IG1/media_publish?creation_id=C1");
  });
  it("vendor refusal on container → ok:false with vendor status, never throws", async () => {
    proxy.mockResolvedValueOnce({ ok: true, status: 200, json: { user_id: "IG1" } })
         .mockResolvedValueOnce({ ok: false, status: 400, json: { error: { message: "bad" } } });
    const r = await publishInstagramImageViaComposio(acct, "x", "https://s/x.jpg", { pollDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
  it("a transport failure (proxy returns status 0) → ok:false, never throws", async () => {
    proxy.mockResolvedValueOnce({ ok: false, status: 0, json: { error: "composio_transport_error" } });
    const r = await publishInstagramImageViaComposio(acct, "x", "https://s/x.jpg", { pollDelayMs: 0 });
    expect(r).toEqual({ ok: false, status: 0, raw: { error: "composio_transport_error" } });
  });
  it("a container that never finishes → ok:false 503, publish never called", async () => {
    proxy.mockResolvedValueOnce({ ok: true, status: 200, json: { user_id: "IG1" } })
         .mockResolvedValueOnce({ ok: true, status: 200, json: { id: "C1" } })
         .mockResolvedValue({ ok: true, status: 200, json: { status_code: "IN_PROGRESS" } });
    const r = await publishInstagramImageViaComposio(acct, "x", "https://s/x.jpg", { pollDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
    expect(proxy.mock.calls.some((c) => String(c[0].endpoint).includes("media_publish"))).toBe(false);
  });
});
