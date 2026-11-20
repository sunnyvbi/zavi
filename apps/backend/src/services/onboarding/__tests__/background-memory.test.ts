
import { describe, it, expect, vi, beforeEach } from "vitest";

type Call = { table: string; scope: string; ops: Array<[string, unknown[]]> };
const calls: Call[] = [];
let results: Record<string, { data: unknown; error: unknown }> = {};
function builder(scope: string, table: string) {
  const call: Call = { table, scope, ops: [] };
  calls.push(call);
  const res = () => results[table] ?? { data: null, error: null };
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") return (ok: (v: unknown) => unknown) => Promise.resolve(res()).then(ok);
        if (prop === "maybeSingle") {
          return async () => {
            const r = res();
            return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
          };
        }
        return (...args: unknown[]) => {
          call.ops.push([prop, args]);
          return proxy;
        };
      },
    },
  );
  return proxy;
}
vi.mock("@/services/tenant-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/tenant-client")>()),
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => ({ from: (table: string) => builder(`tenant:${tid}`, table) }),
  globalClient: () => ({ from: (table: string) => builder("global", table) }),
}));

const guarded = vi.fn(async (..._a: unknown[]) => ({ note_id: "n", chunks: 0 }));
vi.mock("@/services/memory/upsert-anchor", () => ({
  upsertAnchorGuarded: (...a: unknown[]) => guarded(...a),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
const send = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/../workers/client", () => ({ inngest: { send: (...a: unknown[]) => send(...a) } }));

import {
  activationHost,
  resetMemoryForRetry,
  startBackgroundMemory,
} from "../background-memory";
import { claimScan, getScanPublic } from "../scan-store";

const SCAN = "AbCdEfGhIjKlMnOp12";

beforeEach(() => {
  calls.length = 0;
  results = {};
  guarded.mockClear();
  send.mockReset();
  send.mockResolvedValue(undefined);
});

describe("activationHost", () => {
  it("normalises the wizard website server-side and refuses junk", () => {
    expect(activationHost({ wizard: { website: "HTTPS://www.Acme.co.uk/about" } })).toBe("acme.co.uk");
    expect(activationHost({ wizard: { website: "javascript:alert(1)" } })).toBeNull();
    expect(activationHost({ wizard: { website: "localhost" } })).toBeNull();
    expect(activationHost(undefined)).toBeNull();
  });
});

describe("startBackgroundMemory", () => {
  it("claims the scan, inserts the row once, seeds 4 guarded placeholders, sends ids only", async () => {
    results.onboarding_scans = { data: [{ public_id: SCAN }], error: null };
    const r = await startBackgroundMemory({ tenantId: "t1", userId: "u1", scanId: SCAN, host: "acme.com", initialName: "Acme" });
    expect(r.status).toBe("pending");

    const claim = calls.find((c) => c.table === "onboarding_scans")!;
    expect(claim.scope).toBe("global");
    expect(claim.ops).toEqual(
      expect.arrayContaining([
        ["update", [{ claimed_by: "u1" }]],
        ["eq", ["public_id", SCAN]],
        ["eq", ["host", "acme.com"]],
        ["or", ["claimed_by.is.null,claimed_by.eq.u1"]],
      ]),
    );

    const row = calls.find((c) => c.table === "tenant_onboarding_memory")!;
    expect(row.scope).toBe("tenant:t1");
    const [op, args] = row.ops[0];
    expect(op).toBe("upsert");
    expect(args[0]).toMatchObject({ user_id: "u1", host: "acme.com", initial_name: "Acme", scan_public_id: SCAN, status: "pending", attempt: 0 });
    expect(args[1]).toEqual({ onConflict: "tenant_id", ignoreDuplicates: true });

    expect(guarded.mock.calls.map((c) => (c[0] as { slug: string }).slug)).toEqual(["ops", "policies", "disputes", "support"]);
    for (const c of guarded.mock.calls) {
      expect(c[0]).toMatchObject({ tenant_id: "t1", source: "onboarding_seed", metadata: { seed: "placeholder" } });
      expect(c[1]).toEqual(["onboarding_seed"]);
    }
    expect(send).toHaveBeenCalledWith({ name: "tenant/onboarding.memory.requested", data: { tenant_id: "t1", attempt: 0 } });
  });

  it("a scan claimed by someone else (or another host) is not kept", async () => {
    results.onboarding_scans = { data: [], error: null };
    await startBackgroundMemory({ tenantId: "t1", userId: "u1", scanId: SCAN, host: "acme.com", initialName: "Acme" });
    const row = calls.find((c) => c.table === "tenant_onboarding_memory")!;
    expect((row.ops[0][1][0] as { scan_public_id: unknown }).scan_public_id).toBeNull();
  });

  it("with no host the scan is never claimed", async () => {
    await startBackgroundMemory({ tenantId: "t1", userId: "u1", scanId: SCAN, host: null, initialName: "Acme" });
    expect(calls.some((c) => c.table === "onboarding_scans")).toBe(false);
  });

  it("a failed enqueue marks the row failed so the Brain card offers Retry", async () => {
    send.mockRejectedValueOnce(new Error("inngest down"));
    const r = await startBackgroundMemory({ tenantId: "t1", userId: "u1", scanId: null, host: "acme.com", initialName: "Acme" });
    expect(r.status).toBe("failed");
    const fail = calls.filter((c) => c.table === "tenant_onboarding_memory").find((c) => c.ops[0][0] === "update")!;
    expect(fail.ops[0][1][0]).toMatchObject({ status: "failed" });
    expect(fail.ops).toEqual(expect.arrayContaining([["eq", ["status", "pending"]]]));
  });
});

describe("claimScan", () => {
  it("refuses a malformed id without a query", async () => {
    expect(await claimScan("x'; drop", "acme.com", "u1")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("getScanPublic", () => {
  it("returns status + host only, never the payload", async () => {
    results.onboarding_scans = {
      data: { status: "done", host: "acme.com", expires_at: new Date(Date.now() + 60_000).toISOString(), enrichment: { secret: 1 } },
      error: null,
    };
    expect(await getScanPublic(SCAN)).toEqual({ status: "done", host: "acme.com" });
    expect(calls[0].ops[0]).toEqual(["select", ["status, host, expires_at"]]);
  });

  it("is null for an expired scan", async () => {
    results.onboarding_scans = { data: { status: "done", host: "acme.com", expires_at: new Date(Date.now() - 1).toISOString() }, error: null };
    expect(await getScanPublic(SCAN)).toBeNull();
  });
});

describe("resetMemoryForRetry", () => {
  const row = { tenant_id: "t1", user_id: "u1", host: "acme.com", initial_name: "Acme", scan_public_id: SCAN, status: "failed" as const, attempt: 1 };

  it("failed -> pending in one conditional write, attempt + 1, scan dropped", async () => {
    results.tenant_onboarding_memory = { data: [{ attempt: 2 }], error: null };
    expect(await resetMemoryForRetry("t1", row)).toBe(2);
    const c = calls[0];
    expect(c.ops[0][1][0]).toMatchObject({ status: "pending", attempt: 2, scan_public_id: null, error: null });
    expect(c.ops).toEqual(expect.arrayContaining([["eq", ["status", "failed"]], ["eq", ["attempt", 1]]]));
  });

  it("null when someone else already reset it", async () => {
    results.tenant_onboarding_memory = { data: [], error: null };
    expect(await resetMemoryForRetry("t1", row)).toBeNull();
  });
});
