import { describe, it, expect, vi } from "vitest";
import { ensureDnsCname, deleteDnsCname } from "@/services/provisioning/cloudflare-dns";

function res(status: number, body: unknown = {}) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}
const ok = <T>(result: T) => ({ success: true, result, errors: [] });

const NAME = "acme-deadbeef.zaviagent.com";
const TARGET = "acme-deadbeef.onrender.com";
const DEPS = { token: () => "cf_tok", zoneId: () => "zone_1" };

describe("ensureDnsCname", () => {
  it("skips (no fetch) when the token is missing", async () => {
    const fetchFn = vi.fn();
    const r = await ensureDnsCname(NAME, TARGET, { token: () => null, zoneId: () => "zone_1", fetchFn: fetchFn as never });
    expect(r).toEqual({ record_id: null, skipped: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("skips (no fetch) when the zone id is missing", async () => {
    const fetchFn = vi.fn();
    const r = await ensureDnsCname(NAME, TARGET, { token: () => "cf_tok", zoneId: () => null, fetchFn: fetchFn as never });
    expect(r).toEqual({ record_id: null, skipped: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("creates a new DNS-only CNAME (ttl 300, proxied false, right name+content)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, ok([])))
      .mockResolvedValueOnce(res(200, ok({ id: "rec_new" })));
    const r = await ensureDnsCname(NAME, TARGET, { ...DEPS, fetchFn: fetchFn as never });
    expect(r).toEqual({ record_id: "rec_new" });

    const [createUrl, createInit] = fetchFn.mock.calls[1];
    expect(createUrl).toBe("https://api.cloudflare.com/client/v4/zones/zone_1/dns_records");
    expect(createInit.method).toBe("POST");
    expect(JSON.parse(createInit.body)).toEqual({
      type: "CNAME",
      name: NAME,
      content: TARGET,
      ttl: 300,
      proxied: false,
    });
  });

  it("idempotent: existing record with same target → no create", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, ok([{ id: "rec_x", name: NAME, type: "CNAME", content: TARGET }])));
    const r = await ensureDnsCname(NAME, TARGET, { ...DEPS, fetchFn: fetchFn as never });
    expect(r).toEqual({ record_id: "rec_x" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("cross-tenant safety: a FOREIGN record in the list is never mutated → creates fresh", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, ok([{ id: "rec_foreign", name: "someone-else.zaviagent.com", type: "CNAME", content: "other.onrender.com" }])))
      .mockResolvedValueOnce(res(200, ok({ id: "rec_mine" })));
    const r = await ensureDnsCname(NAME, TARGET, { ...DEPS, fetchFn: fetchFn as never });
    expect(r).toEqual({ record_id: "rec_mine" });
    const [url, init] = fetchFn.mock.calls[1];
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones/zone_1/dns_records");
    expect(init.method).toBe("POST");
  });

  it("updates (PATCH) when the existing record points at a different target", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, ok([{ id: "rec_x", name: NAME, type: "CNAME", content: "old.onrender.com" }])))
      .mockResolvedValueOnce(res(200, ok({ id: "rec_x" })));
    const r = await ensureDnsCname(NAME, TARGET, { ...DEPS, fetchFn: fetchFn as never });
    expect(r).toEqual({ record_id: "rec_x" });

    const [patchUrl, patchInit] = fetchFn.mock.calls[1];
    expect(patchUrl).toBe("https://api.cloudflare.com/client/v4/zones/zone_1/dns_records/rec_x");
    expect(patchInit.method).toBe("PATCH");
    expect(JSON.parse(patchInit.body)).toEqual({
      type: "CNAME",
      name: NAME,
      content: TARGET,
      ttl: 300,
      proxied: false,
    });
  });

  it("built-in mode refuses to repoint a CNAME that is not an app host (e.g. www → CloudFront)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, ok([{ id: "rec_www", name: NAME, type: "CNAME", content: "d1.cloudfront.net" }])));
    await expect(
      ensureDnsCname(NAME, TARGET, { ...DEPS, fetchFn: fetchFn as never }, false, { onlyReplaceOnrender: true }),
    ).rejects.toThrow("already in use by another app");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("built-in mode still repoints a drifted app-host CNAME", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, ok([{ id: "rec_x", name: NAME, type: "CNAME", content: "old.onrender.com" }])))
      .mockResolvedValueOnce(res(200, ok({ id: "rec_x" })));
    const r = await ensureDnsCname(NAME, TARGET, { ...DEPS, fetchFn: fetchFn as never }, false, { onlyReplaceOnrender: true });
    expect(r).toEqual({ record_id: "rec_x" });
    expect(fetchFn.mock.calls[1][1].method).toBe("PATCH");
  });

  it("throws on an API error (success:false)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, ok([])))
      .mockResolvedValueOnce(res(400, { success: false, errors: [{ code: 1004, message: "bad CNAME" }] }));
    await expect(ensureDnsCname(NAME, TARGET, { ...DEPS, fetchFn: fetchFn as never })).rejects.toThrow(
      /cloudflare dns create failed.*1004:bad CNAME/,
    );
  });

  it("throws on a non-2xx list", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(res(403, { success: false, errors: [{ code: 9109, message: "no perm" }] }));
    await expect(ensureDnsCname(NAME, TARGET, { ...DEPS, fetchFn: fetchFn as never })).rejects.toThrow(
      /cloudflare dns list failed/,
    );
  });
});

describe("deleteDnsCname", () => {
  it("finds + DELETEs the record", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, ok([{ id: "rec_x", name: NAME, type: "CNAME", content: TARGET }])))
      .mockResolvedValueOnce(res(200, ok({ id: "rec_x" })));
    await deleteDnsCname(NAME, { ...DEPS, fetchFn: fetchFn as never });

    const [delUrl, delInit] = fetchFn.mock.calls[1];
    expect(delUrl).toBe("https://api.cloudflare.com/client/v4/zones/zone_1/dns_records/rec_x");
    expect(delInit.method).toBe("DELETE");
  });

  it("built-in teardown never deletes a platform CNAME named in tenant JSON", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, ok([{ id: "rec_www", name: NAME, type: "CNAME", content: "d1.cloudfront.net" }])));
    await deleteDnsCname(NAME, { ...DEPS, fetchFn: fetchFn as never }, { onlyOnrender: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("built-in teardown still deletes the app-host CNAME", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, ok([{ id: "rec_x", name: NAME, type: "CNAME", content: TARGET }])))
      .mockResolvedValueOnce(res(200, ok({ id: "rec_x" })));
    await deleteDnsCname(NAME, { ...DEPS, fetchFn: fetchFn as never }, { onlyOnrender: true });
    expect(fetchFn.mock.calls[1][1].method).toBe("DELETE");
  });

  it("no-op when unconfigured (no fetch)", async () => {
    const fetchFn = vi.fn();
    await deleteDnsCname(NAME, { token: () => null, zoneId: () => "z", fetchFn: fetchFn as never });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("no-op when the record is already gone (only the lookup runs)", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(res(200, ok([])));
    await deleteDnsCname(NAME, { ...DEPS, fetchFn: fetchFn as never });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
