
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; tenant_id: string; request_key: string | null };
const h = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; tenant_id: string; request_key: string | null }>,
  failUpdate: null as null | { code?: string; message: string },
  failSelect: null as null | { message: string },
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => ({
    from: (table: string) => {
      if (table !== "conductor_runs") throw new Error(`unexpected table ${table}`);
      const filters: Array<[string, unknown]> = [["tenant_id", tid]];
      const match = (r: Row) => filters.every(([c, v]) => (r as Record<string, unknown>)[c] === v);
      return {
        update(values: Partial<Row>) {
          const b = {
            eq(c: string, v: unknown) {
              filters.push([c, v]);
              return b;
            },
            then(resolve: (v: unknown) => void) {
              if (h.failUpdate) return resolve({ error: h.failUpdate });
              const key = values.request_key;
              const target = h.rows.find(match);
              if (target && key && h.rows.some((r) => r !== target && r.tenant_id === target.tenant_id && r.request_key === key)) {
                return resolve({ error: { code: "23505", message: "duplicate key value" } });
              }
              if (target) Object.assign(target, values);
              resolve({ error: null });
            },
          };
          return b;
        },
        select() {
          const b = {
            eq(c: string, v: unknown) {
              filters.push([c, v]);
              return b;
            },
            maybeSingle: async () => {
              if (h.failSelect) return { data: null, error: h.failSelect };
              const hit = h.rows.find(match);
              return { data: hit ? { id: hit.id } : null, error: null };
            },
          };
          return b;
        },
      };
    },
  }),
}));

import { buildRequestKeyFrom, DuplicateBuildRequest, stampBuildRequestKey } from "../build-request-key";
import { resolveStaleBuildStart, STALE_RESOLVERS } from "@/services/http/stale-resolvers";

const T1 = "t-1";
const T2 = "t-2";
const KEY = "0b5c7f2e-1111-4222-8333-444455556666";

beforeEach(() => {
  h.rows.length = 0;
  h.failUpdate = null;
  h.failSelect = null;
});

describe("build request key", () => {
  it("accepts only a valid Idempotency-Key header", () => {
    expect(buildRequestKeyFrom(KEY)).toBe(KEY);
    expect(buildRequestKeyFrom([KEY])).toBe(KEY);
    expect(buildRequestKeyFrom("short")).toBeNull();
    expect(buildRequestKeyFrom("has space in it")).toBeNull();
    expect(buildRequestKeyFrom(undefined)).toBeNull();
  });

  it("stamps the key on the new run, tenant-scoped", async () => {
    h.rows.push({ id: "run-1", tenant_id: T1, request_key: null });
    await stampBuildRequestKey(T1, "run-1", KEY);
    expect(h.rows[0].request_key).toBe(KEY);
  });

  it("a key already on another run of the tenant names THAT run (the request's real build)", async () => {
    h.rows.push({ id: "run-orig", tenant_id: T1, request_key: KEY }, { id: "run-2", tenant_id: T1, request_key: null });
    const err = await stampBuildRequestKey(T1, "run-2", KEY).catch((e) => e);
    expect(err).toBeInstanceOf(DuplicateBuildRequest);
    expect((err as DuplicateBuildRequest).conductor_run_id).toBe("run-orig");
  });

  it("any other write error throws (the run never builds without its key)", async () => {
    h.rows.push({ id: "run-1", tenant_id: T1, request_key: null });
    h.failUpdate = { message: "timeout" };
    await expect(stampBuildRequestKey(T1, "run-1", KEY)).rejects.toThrow(/could not record the build request key/);
  });
});

describe("stale build-start claim", () => {
  it("is resolved for the build-product route", () => {
    expect(STALE_RESOLVERS["/api/workspace/autopilot/build-product"]).toBe(resolveStaleBuildStart);
  });

  it("found: answers with the run that carries the key", async () => {
    h.rows.push({ id: "run-orig", tenant_id: T1, request_key: KEY });
    expect(await resolveStaleBuildStart({ tenant_id: T1, user_id: "u", key: KEY })).toEqual({
      status: 200,
      body: { ok: true, conductor_run_id: "run-orig", replayed_after_stale: true },
    });
  });

  it("another tenant's run with the same key is not this request's build", async () => {
    h.rows.push({ id: "run-theirs", tenant_id: T2, request_key: KEY });
    expect(await resolveStaleBuildStart({ tenant_id: T1, user_id: "u", key: KEY })).toBe("not_found");
  });

  it("a read error is unknown, never not_found", async () => {
    h.failSelect = { message: "db down" };
    await expect(resolveStaleBuildStart({ tenant_id: T1, user_id: "u", key: KEY })).rejects.toThrow(/lookup failed/);
  });
});
