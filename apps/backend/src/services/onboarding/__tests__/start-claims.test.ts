
import { describe, expect, it } from "vitest";

import { claimStart, recordStartClaim, waitForClaimedTenant } from "../start-claims";

type Row = Record<string, unknown>;
type Claim = { user_id: string; idem_key: string; tenant_id: string | null; conductor_run_id: string | null; created_at: string };

function fakeSb(db: { claims: Claim[]; runs?: Row[]; links?: Row[]; tenants?: Row[] }, opts: { insertFails?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    build_start_claims: db.claims as unknown as Row[],
    conductor_runs: db.runs ?? [],
    tenant_users: db.links ?? [],
    tenants: db.tenants ?? [],
  };
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const rows = () => tables[table].filter((r) => filters.every((f) => f(r)));
    const chain = {
      eq(c: string, v: unknown) {
        filters.push((r) => r[c] === v);
        return chain;
      },
      is(c: string, v: unknown) {
        filters.push((r) => (r[c] ?? null) === v);
        return chain;
      },
      in(c: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[c]));
        return chain;
      },
      gte(c: string, v: string) {
        filters.push((r) => String(r[c]) >= v);
        return chain;
      },
      order() {
        return chain;
      },
      limit() {
        return Promise.resolve({ data: rows(), error: null });
      },
      select() {
        return chain;
      },
      async maybeSingle() {
        const hit = rows()[0];
        return { data: hit ? { ...hit } : null, error: null };
      },
      then(resolve: (v: unknown) => void) {
        resolve({ data: rows(), error: null });
      },
    };
    return {
      async insert(row: Partial<Claim>) {
        if (opts.insertFails) return { error: { code: "XX000", message: "down" } };
        if (db.claims.some((c) => c.user_id === row.user_id && c.idem_key === row.idem_key)) {
          return { error: { code: "23505", message: "duplicate" } };
        }
        db.claims.push({ tenant_id: null, conductor_run_id: null, created_at: new Date().toISOString(), ...row } as Claim);
        return { error: null };
      },
      select: () => chain,
      update(values: Row) {
        const u = {
          eq(c: string, v: unknown) {
            filters.push((r) => r[c] === v);
            return u;
          },
          is(c: string, v: unknown) {
            filters.push((r) => (r[c] ?? null) === v);
            return u;
          },
          async select() {
            const hit = rows();
            for (const r of hit) Object.assign(r, values);
            return { data: hit, error: null };
          },
        };
        return u;
      },
    };
  };
  return { from } as never;
}

const U = "user-1";
const KEY = "0b5c7f2e-aaaa-4222-8333-444455556666";
const old = () => new Date(Date.now() - 11 * 60 * 1000).toISOString();

describe("start claim (build-start: run required)", () => {
  it("the first request owns the key, with its owner token", async () => {
    const claims: Claim[] = [];
    const out = await claimStart(fakeSb({ claims }), U, KEY);
    expect(out.kind).toBe("owned");
    expect((out as { token: string }).token).toBe(claims[0].created_at);
  });

  it("a retry after the build started replays it (no second tenant)", async () => {
    const claims: Claim[] = [{ user_id: U, idem_key: KEY, tenant_id: "t-1", conductor_run_id: "run-1", created_at: old() }];
    expect(await claimStart(fakeSb({ claims }), U, KEY)).toEqual({ kind: "replay", tenant_id: "t-1", conductor_run_id: "run-1" });
  });

  it("the tenant exists and its run carries the key (claim update lost): replays that run", async () => {
    const claims: Claim[] = [{ user_id: U, idem_key: KEY, tenant_id: "t-1", conductor_run_id: null, created_at: old() }];
    const runs = [{ id: "run-9", tenant_id: "t-1", request_key: KEY }];
    expect(await claimStart(fakeSb({ claims, runs }), U, KEY)).toEqual({ kind: "replay", tenant_id: "t-1", conductor_run_id: "run-9" });
    expect(claims[0].conductor_run_id).toBe("run-9");
  });

  it("the tenant exists without a build: never a second tenant, the client opens this one", async () => {
    const claims: Claim[] = [{ user_id: U, idem_key: KEY, tenant_id: "t-1", conductor_run_id: null, created_at: old() }];
    expect(await claimStart(fakeSb({ claims }), U, KEY)).toEqual({ kind: "busy", stale: true, tenant_id: "t-1" });
  });

  it("a stale claim that died before recording its tenant: the tenant it created is found, not created again", async () => {
    const at = old();
    const claims: Claim[] = [{ user_id: U, idem_key: KEY, tenant_id: null, conductor_run_id: null, created_at: at }];
    const links = [{ user_id: U, tenant_id: "t-old" }, { user_id: U, tenant_id: "t-new" }];
    const tenants = [
      { id: "t-old", created_at: "2020-01-01T00:00:00.000Z" },
      { id: "t-new", created_at: new Date(Date.parse(at) + 1000).toISOString() },
    ];
    expect(await claimStart(fakeSb({ claims, links, tenants }), U, KEY)).toEqual({ kind: "busy", stale: true, tenant_id: "t-new" });
    expect(claims[0].tenant_id).toBe("t-new");
  });

  it("still in progress (fresh claim, nothing created yet): busy", async () => {
    const claims: Claim[] = [{ user_id: U, idem_key: KEY, tenant_id: null, conductor_run_id: null, created_at: new Date().toISOString() }];
    expect(await claimStart(fakeSb({ claims }), U, KEY)).toEqual({ kind: "busy", stale: false, tenant_id: null });
  });

  it("stale with provably nothing created: the retry takes the claim over with a NEW owner token", async () => {
    const at = old();
    const claims: Claim[] = [{ user_id: U, idem_key: KEY, tenant_id: null, conductor_run_id: null, created_at: at }];
    const out = await claimStart(fakeSb({ claims, links: [] }), U, KEY);
    expect(out.kind).toBe("owned");
    expect((out as { token: string }).token).not.toBe(at);
    expect(claims[0].created_at).toBe((out as { token: string }).token);
  });

  it("a superseded request (old token) can never record onto the new owner's claim", async () => {
    const claims: Claim[] = [{ user_id: U, idem_key: KEY, tenant_id: null, conductor_run_id: null, created_at: "2026-10-02T00:10:00.000Z" }];
    const sb = fakeSb({ claims });
    expect(await recordStartClaim(sb, U, KEY, "2026-10-02T00:00:00.000Z", { tenant_id: "t-stale" })).toBe(false);
    expect(claims[0].tenant_id).toBeNull();
    expect(await recordStartClaim(sb, U, KEY, "2026-10-02T00:10:00.000Z", { tenant_id: "t-owner" })).toBe(true);
    expect(claims[0].tenant_id).toBe("t-owner");
  });

  it("another user's claim on the same key is not this user's", async () => {
    const claims: Claim[] = [{ user_id: "user-2", idem_key: KEY, tenant_id: "t-2", conductor_run_id: "run-2", created_at: old() }];
    expect((await claimStart(fakeSb({ claims }), U, KEY)).kind).toBe("owned");
  });

  it("an unreadable claim store fails closed", async () => {
    expect(await claimStart(fakeSb({ claims: [] }, { insertFails: true }), U, KEY)).toEqual({ kind: "unavailable" });
  });
});

describe("start claim without a run (activate)", () => {
  const ACT = `activate:${KEY}`;

  it("a retry after the workspace was created replays it (no second tenant)", async () => {
    const claims: Claim[] = [{ user_id: U, idem_key: ACT, tenant_id: "t-1", conductor_run_id: null, created_at: new Date().toISOString() }];
    expect(await claimStart(fakeSb({ claims }), U, ACT, { runRequired: false })).toEqual({ kind: "replay", tenant_id: "t-1", conductor_run_id: null });
  });

  it("a stale claim that died before recording its tenant: replays the tenant it created and records it", async () => {
    const at = old();
    const claims: Claim[] = [{ user_id: U, idem_key: ACT, tenant_id: null, conductor_run_id: null, created_at: at }];
    const links = [{ user_id: U, tenant_id: "t-new" }];
    const tenants = [{ id: "t-new", created_at: new Date(Date.parse(at) + 1000).toISOString() }];
    expect(await claimStart(fakeSb({ claims, links, tenants }), U, ACT, { runRequired: false })).toEqual({ kind: "replay", tenant_id: "t-new", conductor_run_id: null });
    expect(claims[0].tenant_id).toBe("t-new");
  });

  it("still in progress: busy, nothing replayed", async () => {
    const claims: Claim[] = [{ user_id: U, idem_key: ACT, tenant_id: null, conductor_run_id: null, created_at: new Date().toISOString() }];
    expect(await claimStart(fakeSb({ claims }), U, ACT, { runRequired: false })).toEqual({ kind: "busy", stale: false, tenant_id: null });
  });
});

describe("waitForClaimedTenant", () => {
  it("answers with the tenant once the first request records it", async () => {
    const claims: Claim[] = [{ user_id: U, idem_key: KEY, tenant_id: null, conductor_run_id: null, created_at: new Date().toISOString() }];
    setTimeout(() => (claims[0].tenant_id = "t-1"), 5);
    expect(await waitForClaimedTenant(fakeSb({ claims }), U, KEY, { timeoutMs: 1000, stepMs: 2 })).toBe("t-1");
  });

  it("null when the claim is gone (the first request was refused) or time runs out", async () => {
    expect(await waitForClaimedTenant(fakeSb({ claims: [] }), U, KEY, { timeoutMs: 50, stepMs: 2 })).toBeNull();
    const claims: Claim[] = [{ user_id: U, idem_key: KEY, tenant_id: null, conductor_run_id: null, created_at: new Date().toISOString() }];
    expect(await waitForClaimedTenant(fakeSb({ claims }), U, KEY, { timeoutMs: 20, stepMs: 2 })).toBeNull();
  });
});
