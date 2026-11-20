import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn() }));
vi.mock("@/services/provisioning/secret", () => ({ setResourceSecret: vi.fn() }));

import { attachAppDatabase, HostingServiceMissingError } from "@/services/provisioning/render-hosting";

function res(status: number, body: unknown = {}) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

function deps(over: Record<string, unknown> = {}) {
  const fetchFn = vi.fn().mockResolvedValue(res(200));
  return {
    fetchFn,
    d: {
      token: () => "tok",
      fetchFn: fetchFn as never,
      resolveServiceId: vi.fn().mockResolvedValue("srv-1"),
      dbUrl: vi.fn().mockResolvedValue("postgres://u:p@h/db"),
      sessionSecret: vi.fn().mockResolvedValue({ value: "s".repeat(64), created: false }),
      ...over,
    },
  };
}

describe("attachAppDatabase", () => {
  it("PUTs DATABASE_URL (sslmode=require) + SESSION_SECRET and never triggers a deploy", async () => {
    const { fetchFn, d } = deps();
    const r = await attachAppDatabase("t1", d);
    expect(r).toEqual({ render_service_id: "srv-1" });
    const urls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual([
      "https://api.render.com/v1/services/srv-1/env-vars/DATABASE_URL",
      "https://api.render.com/v1/services/srv-1/env-vars/SESSION_SECRET",
    ]);
    expect(fetchFn.mock.calls.every((c) => c[1].method === "PUT")).toBe(true);
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ value: "postgres://u:p@h/db?sslmode=require" });
    expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toEqual({ value: "s".repeat(64) });
    expect(urls.some((u) => u.endsWith("/deploys"))).toBe(false);
  });

  it("uses the tenant it was given to find the service", async () => {
    const { d } = deps();
    await attachAppDatabase("t1", d);
    expect(d.resolveServiceId).toHaveBeenCalledWith("t1");
  });

  it("throws on a non-2xx PUT", async () => {
    const { d } = deps({ fetchFn: vi.fn().mockResolvedValue(res(500, { m: "boom" })) as never });
    await expect(attachAppDatabase("t1", d)).rejects.toThrow(/DATABASE_URL.*500/);
  });

  it("throws when the second PUT fails", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(res(200)).mockResolvedValueOnce(res(403));
    const { d } = deps({ fetchFn: fetchFn as never });
    await expect(attachAppDatabase("t1", d)).rejects.toThrow(/SESSION_SECRET.*403/);
  });

  it("throws when the PUT itself throws", async () => {
    const { d } = deps({ fetchFn: vi.fn().mockRejectedValue(new Error("ECONNRESET")) as never });
    await expect(attachAppDatabase("t1", d)).rejects.toThrow(/ECONNRESET/);
  });

  it("throws when the tenant has no Render service", async () => {
    const { fetchFn, d } = deps({ resolveServiceId: vi.fn().mockResolvedValue(null) });
    const err = await attachAppDatabase("t1", d).catch((e) => e);
    expect(err).toBeInstanceOf(HostingServiceMissingError);
    expect(err.message).toBe("attach app database: no provisioned Render service for tenant t1");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("only the missing-service case is a HostingServiceMissingError", async () => {
    const put = deps({ fetchFn: vi.fn().mockResolvedValue(res(500)) as never });
    const thrown = deps({ fetchFn: vi.fn().mockRejectedValue(new Error("ECONNRESET")) as never });
    const noToken = deps({ token: () => null });
    for (const { d } of [put, thrown, noToken]) {
      const err = await attachAppDatabase("t1", d).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(HostingServiceMissingError);
    }
  });

  it("throws when the connection string cannot be resolved", async () => {
    vi.useFakeTimers();
    try {
      const { fetchFn, d } = deps({ dbUrl: vi.fn().mockResolvedValue(null) });
      const p = attachAppDatabase("t1", d);
      const assertion = expect(p).rejects.toThrow(/could not be resolved/);
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws CredentialNotConfigured without a Render token", async () => {
    const { d } = deps({ token: () => null });
    await expect(attachAppDatabase("t1", d)).rejects.toThrow(/RENDER_API_KEY/);
  });
});
