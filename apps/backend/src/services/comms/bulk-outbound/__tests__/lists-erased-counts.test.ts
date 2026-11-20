import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  tenants: [] as string[],
  erased: [] as string[],
  held: [] as Array<{ version_id: string; contact_id: string }>,
  batches: [] as number[],
  failContacts: false,
  failHeld: false,
  throwOnFrom: false,
  versionFilters: [] as string[][],
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (...a: unknown[]) => mocks.rpc(...a),
  tenantClient: (tenant: string) => {
    mocks.tenants.push(tenant);
    return {
      from: (table: string) => {
        if (mocks.throwOnFrom) throw new Error("no facade");
        if (table === "email_contacts") {
          return {
            select: () => ({
              not: (col: string, op: string, value: unknown) => {
                expect([col, op, value]).toEqual(["erased_at", "is", null]);
                return Promise.resolve(mocks.failContacts ? { data: null, error: { message: "ada@example.com" } } : { data: mocks.erased.map((id) => ({ id })), error: null });
              },
            }),
          };
        }
        const filters: Record<string, string[]> = {};
        const chain = {
          select: () => chain,
          in(col: string, values: string[]) {
            filters[col] = values;
            if (col === "contact_id") {
              mocks.batches.push(values.length);
              mocks.versionFilters.push(filters.version_id);
              return Promise.resolve(
                mocks.failHeld
                  ? { data: null, error: { message: "boom" } }
                  : { data: mocks.held.filter((m) => filters.version_id.includes(m.version_id) && values.includes(m.contact_id)), error: null },
              );
            }
            return chain;
          },
        };
        return chain;
      },
    };
  },
}));

import { listSummaries } from "../lists";

const version = (id: string, count: number) => ({ id, source_kind: "csv", source_ref: {}, contact_count: count, created_at: "2026-10-01T00:00:00Z", consented: true });
const row = (id: string, latest: ReturnType<typeof version> | null, active: { id: string; contact_count: number; blocked: number } | null) => ({
  id,
  name: id,
  created_at: "2026-10-01T00:00:00Z",
  active_version_id: active?.id ?? null,
  latest,
  active: active ? { ...active, source_kind: "csv" } : null,
});

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.tenants.length = 0;
  mocks.erased = [];
  mocks.held = [];
  mocks.batches.length = 0;
  mocks.versionFilters.length = 0;
  mocks.failContacts = false;
  mocks.failHeld = false;
  mocks.throwOnFrom = false;
});

describe("list counts after an erase", () => {
  it("the person leaves the people count; who can be emailed is unchanged; erased no longer reads as unsubscribed or bounced", async () => {
    mocks.rpc.mockResolvedValue({ data: [row("L", version("v1", 5), { id: "v1", contact_count: 5, blocked: 2 })], error: null });
    mocks.erased = ["c1"];
    mocks.held = [{ version_id: "v1", contact_id: "c1" }];
    const [l] = await listSummaries("tenant-a");
    expect(l.active).toMatchObject({ contact_count: 4, sendable: 3, unsubscribed_or_bounced: 1 });
    expect(l.latest?.contact_count).toBe(4);
    expect(new Set(mocks.tenants)).toEqual(new Set(["tenant-a"]));
  });

  it("each version loses only its own members: a newer import without the person keeps its count", async () => {
    mocks.rpc.mockResolvedValue({ data: [row("L", version("v2", 3), { id: "v1", contact_count: 5, blocked: 1 })], error: null });
    mocks.erased = ["c1"];
    mocks.held = [{ version_id: "v1", contact_id: "c1" }];
    const [l] = await listSummaries("tenant-a");
    expect(l.active?.contact_count).toBe(4);
    expect(l.latest?.contact_count).toBe(3);
  });

  it("a list that was never consented, with no active version, still drops the person", async () => {
    mocks.rpc.mockResolvedValue({ data: [row("L", version("v9", 1), null)], error: null });
    mocks.erased = ["c1"];
    mocks.held = [{ version_id: "v9", contact_id: "c1" }];
    const [l] = await listSummaries("tenant-a");
    expect(l.latest?.contact_count).toBe(0);
  });

  it("250 erased people are read in batches a URL can carry, and all of them count", async () => {
    mocks.rpc.mockResolvedValue({ data: [row("L", version("v1", 300), { id: "v1", contact_count: 300, blocked: 250 })], error: null });
    mocks.erased = Array.from({ length: 250 }, (_, i) => `c${i}`);
    mocks.held = mocks.erased.map((contact_id) => ({ version_id: "v1", contact_id }));
    const [l] = await listSummaries("tenant-a");
    expect(mocks.batches).toEqual([100, 100, 50]);
    expect(l.active).toMatchObject({ contact_count: 50, sendable: 50, unsubscribed_or_bounced: 0 });
  });

  it.each([
    ["the erased read fails", () => (mocks.failContacts = true)],
    ["a later membership read fails", () => (mocks.failHeld = true)],
    ["the table facade throws", () => (mocks.throwOnFrom = true)],
  ])("%s: the list still loads with the stored counts, and who can be emailed stays right", async (_n, arrange) => {
    mocks.rpc.mockResolvedValue({ data: [row("L", version("v1", 5), { id: "v1", contact_count: 5, blocked: 2 })], error: null });
    mocks.erased = ["c1"];
    mocks.held = [{ version_id: "v1", contact_id: "c1" }];
    arrange();
    const [l] = await listSummaries("tenant-a");
    expect(l.active).toMatchObject({ contact_count: 5, sendable: 3, unsubscribed_or_bounced: 2 });
  });

  it("no erased people means no extra reads per list", async () => {
    mocks.rpc.mockResolvedValue({ data: [row("L", version("v1", 5), { id: "v1", contact_count: 5, blocked: 0 })], error: null });
    await listSummaries("tenant-a");
    expect(mocks.batches).toEqual([]);
  });
});
