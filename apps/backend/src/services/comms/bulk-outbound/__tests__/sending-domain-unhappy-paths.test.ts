import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  log: vi.fn(async (..._a: unknown[]) => {}),
  row: null as null | Record<string, unknown>,
  readError: null as null | { message: string },
  reads: 0,
  failReadAt: 0,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.log }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (...a: unknown[]) => mocks.rpc(...a),
  globalClient: () => ({ from: () => ({}) }),
  tenantClient: () => ({
    from: () => ({
      select: () => ({
        maybeSingle: async () => {
          mocks.reads += 1;
          if (mocks.failReadAt === mocks.reads) return { data: null, error: { message: "boom" } };
          return { data: mocks.row, error: null };
        },
      }),
    }),
  }),
}));

import { addSendingDomain, markSendingDomainUnverified, recheckSendingDomainIfStale, resolveBulkSender, verifySendingDomain } from "../sending-domain";

const URL_HERE = "https://here.supabase.co";
const ORIGIN = { origin: createHash("sha256").update(URL_HERE).digest("hex").slice(0, 32) };
const CNAME = { type: "CNAME", host: "em1.acme.com", data: "u1.wl.sendgrid.net" };
const ISSUED = {
  mail_cname: { type: "cname", host: "em9.acme.com", data: "u9.wl.sendgrid.net" },
  dkim1: { type: "cname", host: "s1._domainkey.acme.com", data: "s1.domainkey.u9.wl.sendgrid.net" },
  dkim2: { type: "cname", host: "s2._domainkey.acme.com", data: "s2.domainkey.u9.wl.sendgrid.net" },
};
const row = (over: Record<string, unknown> = {}) => ({
  domain: "acme.com",
  from_address: null,
  from_name: null,
  verification_status: "pending",
  verification_error: null,
  dns_records: [CNAME, ORIGIN],
  provider_domain_id: "11",
  verified_at: null,
  last_checked_at: null,
  ...over,
});
const VERIFIED = () => row({ verification_status: "verified", verified_at: "2026-10-01T00:00:00Z", last_checked_at: "2026-10-01T00:00:00Z" });

type Answer = { status: number; body: unknown } | (() => { status: number; body: unknown });
function provider(routes: Partial<Record<"create" | "lookup" | "validate" | "delete", Answer>>) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string, init: { method: string }) => {
    const path = url.replace("https://api.sendgrid.com/v3", "");
    calls.push(`${init.method} ${path}`);
    const name = init.method === "DELETE" ? "delete" : init.method === "GET" ? "lookup" : path.endsWith("/validate") ? "validate" : "create";
    const answer = routes[name] ?? { status: 204, body: null };
    const r = typeof answer === "function" ? answer() : answer;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  });
  return { fn, calls };
}
const rpcNames = () => mocks.rpc.mock.calls.map((c) => c[1]);
const add = (domain: string, fetch: unknown) => addSendingDomain({ tenantId: "t", userId: "u", domain }, { fetch: fetch as never });

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.row = null;
  mocks.reads = 0;
  mocks.failReadAt = 0;
  for (const k of ["BULK_SENDGRID_API_KEY", "SUPABASE_URL"]) saved[k] = process.env[k];
  process.env.BULK_SENDGRID_API_KEY = "bulk-key";
  process.env.SUPABASE_URL = URL_HERE;
  mocks.rpc.mockImplementation(async (_t: string, name: string, a: Record<string, unknown>) => {
    if (name === "tenant_sending_domain_upsert_pending") {
      mocks.row = row({ domain: a.p_domain, provider_domain_id: a.p_provider_domain_id, dns_records: a.p_dns_records });
    }
    return { data: { ok: true }, error: null };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("a provider that never answers", () => {
  function hangsUntilAborted() {
    return vi.fn((_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    );
  }
  function shortTimeouts() {
    const real = AbortSignal.timeout.bind(AbortSignal);
    return vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(5));
  }

  it("Check now gives up with a readable 502 after 15 seconds instead of hanging the request", async () => {
    const timeout = shortTimeouts();
    mocks.row = row();
    await expect(verifySendingDomain({ tenantId: "t" }, { fetch: hangsUntilAborted() as never })).rejects.toMatchObject({ status: 502, code: "email_provider_unreachable" });
    expect(timeout).toHaveBeenCalledWith(15_000);
  });

  it("a send's stale re-check does not hang the chunk, and the stored answer stands", async () => {
    shortTimeouts();
    mocks.row = VERIFIED();
    await recheckSendingDomainIfStale("t", { fetch: hangsUntilAborted() as never, now: () => Date.parse("2026-10-20T00:00:00Z") });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(await resolveBulkSender("t")).toMatchObject({ domain: "acme.com" });
  });

  it("Add gives up and writes nothing", async () => {
    shortTimeouts();
    mocks.row = VERIFIED();
    await expect(add("new.com", hangsUntilAborted())).rejects.toMatchObject({ status: 502, code: "email_provider_unreachable" });
    expect(rpcNames()).toEqual(["tenant_sending_domain_check"]);
  });
});

describe("Add when the provider refuses or half answers", () => {
  it("a provider outage or rate limit is not blamed on the founder's spelling", async () => {
    for (const status of [429, 500, 503]) {
      await expect(add("acme.com", provider({ create: { status, body: { errors: [{ message: "vendor text" }] } } }).fn)).rejects.toMatchObject({
        status: 502,
        code: "email_provider_unreachable",
        message: "We could not reach the email provider. Try again in a minute.",
      });
    }
  });

  it("a domain the provider rejects is a 4xx, so the form stays open with what the founder typed", async () => {
    const err = await add("acme.com", provider({ create: { status: 400, body: { errors: [{ message: "vendor text" }] } } }).fn).catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: "domain_setup_failed" });
    expect(err.message).not.toContain("vendor text");
  });

  it("a created record with no DNS answer is removed and the working domain stays", async () => {
    mocks.row = VERIFIED();
    const { fn, calls } = provider({ create: { status: 201, body: { id: 77, dns: {} } } });
    await expect(add("new.com", fn)).rejects.toMatchObject({ status: 502, code: "domain_setup_failed" });
    expect(calls).toEqual(["POST /whitelabel/domains", "DELETE /whitelabel/domains/77"]);
    expect(rpcNames()).toEqual(["tenant_sending_domain_check"]);
    expect(mocks.row).toMatchObject({ domain: "acme.com", verification_status: "verified" });
  });

  it("a created record with one of its three records broken is removed, never stored as a two-record row", async () => {
    const { fn, calls } = provider({ create: { status: 201, body: { id: 77, dns: { ...ISSUED, dkim2: { type: "cname", host: "s2._domainkey.acme.com" } } } } });
    await expect(add("acme.com", fn)).rejects.toMatchObject({ code: "domain_setup_failed" });
    expect(calls).toContain("DELETE /whitelabel/domains/77");
    expect(rpcNames()).not.toContain("tenant_sending_domain_upsert_pending");
  });
});

describe("Add it again, as the page tells the founder to", () => {
  const CREATED = { status: 201, body: { id: 77, dns: ISSUED } };

  it("after the provider lost the record it issues new records instead of returning the dead row", async () => {
    mocks.row = row({ verification_error: "This domain is no longer set up with the email provider. Add it again." });
    const { fn, calls } = provider({ create: CREATED });
    const out = await add("acme.com", fn);
    expect(calls).toEqual(["POST /whitelabel/domains", "DELETE /whitelabel/domains/11"]);
    expect(mocks.row).toMatchObject({ provider_domain_id: "77", verification_error: null });
    expect(out.dns_records).toHaveLength(3);
    expect(out.last_error).toBeNull();
  });

  it("after the record turned out to be another domain's it issues new records too", async () => {
    mocks.row = row({ verification_error: "This domain changed. Add it again to get its records." });
    const { fn } = provider({ create: CREATED });
    await add("acme.com", fn);
    expect(mocks.row).toMatchObject({ provider_domain_id: "77" });
  });

  it("a pending row with no records to show gets new ones", async () => {
    mocks.row = row({ dns_records: [ORIGIN] });
    const { fn } = provider({ create: CREATED });
    expect((await add("acme.com", fn)).dns_records).toHaveLength(3);
  });

  it("a healthy pending row, and a verified row even with no stored records, are left exactly as they are", async () => {
    mocks.row = row();
    const pending = provider({ create: CREATED });
    await add("ACME.com", pending.fn);
    expect(pending.fn).not.toHaveBeenCalled();

    mocks.row = { ...VERIFIED(), dns_records: [] };
    const verified = provider({ create: CREATED });
    expect(await add("acme.com", verified.fn)).toMatchObject({ status: "verified" });
    expect(verified.fn).not.toHaveBeenCalled();
    expect(rpcNames()).not.toContain("tenant_sending_domain_upsert_pending");
  });
});

describe("two tabs adding at once", () => {
  it("the same domain: the slower tab drops its own record and shows the records already stored", async () => {
    const stored = row({ provider_domain_id: "55" });
    const { fn, calls } = provider({
      create: () => {
        mocks.row = stored;
        return { status: 201, body: { id: 77, dns: ISSUED } };
      },
    });
    const out = await add("acme.com", fn);
    expect(calls).toEqual(["POST /whitelabel/domains", "DELETE /whitelabel/domains/77"]);
    expect(rpcNames()).not.toContain("tenant_sending_domain_upsert_pending");
    expect(mocks.row).toBe(stored);
    expect(out.dns_records).toEqual([CNAME]);
  });

  it("different domains: the record the other tab stored is removed, not left behind unnoticed", async () => {
    const { fn, calls } = provider({
      create: () => {
        mocks.row = row({ domain: "other.com", provider_domain_id: "55" });
        return { status: 201, body: { id: 77, dns: ISSUED } };
      },
    });
    await add("acme.com", fn);
    expect(calls).toEqual(["POST /whitelabel/domains", "DELETE /whitelabel/domains/55"]);
    expect(mocks.row).toMatchObject({ domain: "acme.com", provider_domain_id: "77" });
  });

  it("a remove that lands between the two reads is not deleted twice", async () => {
    mocks.row = row({ domain: "old.com" });
    const { fn, calls } = provider({
      create: () => {
        mocks.row = null;
        return { status: 201, body: { id: 77, dns: ISSUED } };
      },
    });
    await add("acme.com", fn);
    expect(calls).toEqual(["POST /whitelabel/domains"]);
  });

  it("a failed second read removes the new provider record and writes nothing", async () => {
    mocks.failReadAt = 2;
    const { fn, calls } = provider({ create: { status: 201, body: { id: 77, dns: ISSUED } } });
    await expect(add("acme.com", fn)).rejects.toMatchObject({ code: "sending_domain_read_failed" });
    expect(calls).toEqual(["POST /whitelabel/domains", "DELETE /whitelabel/domains/77"]);
    expect(rpcNames()).toEqual(["tenant_sending_domain_check"]);
  });
});

describe("a partial answer never changes what is stored", () => {
  const STALE = () => Date.parse("2026-10-20T00:00:00Z");
  const LOOKUP = { status: 200, body: { id: 11, domain: "acme.com" } };

  it("a lookup with no domain in it does not un-verify a working domain", async () => {
    mocks.row = VERIFIED();
    await recheckSendingDomainIfStale("t", { fetch: provider({ lookup: { status: 200, body: { id: 11 } } }).fn as never, now: STALE });
    expect(mocks.rpc).not.toHaveBeenCalled();
    await expect(verifySendingDomain({ tenantId: "t" }, { fetch: provider({ lookup: { status: 200, body: {} } }).fn as never })).rejects.toMatchObject({ status: 502 });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(await resolveBulkSender("t")).toMatchObject({ domain: "acme.com" });
  });

  it("a validate answer with no verdict does not mark a working domain failed", async () => {
    mocks.row = VERIFIED();
    for (const body of [{}, { valid: "true" }, { valid: null }, { id: 11 }]) {
      await recheckSendingDomainIfStale("t", { fetch: provider({ lookup: LOOKUP, validate: { status: 200, body } }).fn as never, now: STALE });
      await expect(verifySendingDomain({ tenantId: "t" }, { fetch: provider({ lookup: LOOKUP, validate: { status: 200, body } }).fn as never })).rejects.toMatchObject({ status: 502 });
      expect(await markSendingDomainUnverified("t", { fetch: provider({ validate: { status: 200, body } }).fn as never })).toBeNull();
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("a truthy non-boolean verdict never verifies a pending domain", async () => {
    mocks.row = row();
    await expect(verifySendingDomain({ tenantId: "t" }, { fetch: provider({ lookup: LOOKUP, validate: { status: 200, body: { valid: 1 } } }).fn as never })).rejects.toMatchObject({ status: 502 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("the send path's 403 when the provider no longer has the record", () => {
  it("is un-verified with the add-it-again sentence, so a resumed send cannot loop on a domain still shown Verified", async () => {
    mocks.row = VERIFIED();
    const { fn } = provider({ validate: { status: 404, body: { errors: [{ message: "not found" }] } } });
    expect(await markSendingDomainUnverified("t", { fetch: fn as never })).toBe("pending");
    expect(mocks.rpc).toHaveBeenCalledWith("t", "tenant_sending_domain_set_status", {
      p_provider_domain_id: "11",
      p_domain: "acme.com",
      p_status: "pending",
      p_error: "This domain is no longer set up with the email provider. Add it again.",
    });
  });
});
