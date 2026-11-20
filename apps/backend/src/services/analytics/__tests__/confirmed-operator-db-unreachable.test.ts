import { describe, it, expect } from "vitest";
import { resolveConfirmedOperatorDb } from "../confirmed-operator-db";
import { DatabaseUnreachableError } from "@/services/data-gateway";

const gateway = { tenant_id: "t1", caller: { kind: "background", feature: "Metric sweep" } } as never;

describe("resolveConfirmedOperatorDb on an unreachable database", () => {
  it("keeps the unreachable message instead of the bare code", async () => {
    const out = await resolveConfirmedOperatorDb(gateway, "bookings", {
      getCatalog: async () => ({ catalog_hash: "h" }) as never,
      getConfirmedMapping: async () => ({ catalog_hash: "h", confirmed_at: "x", confirmed_map: { bookings: { table: "orders", label: "Orders", created_at_field: "created_at" } } }) as never,
      resolveAttachedDb: async () => {
        throw new DatabaseUnreachableError("Zavi could not connect to this workspace's database.");
      },
    });
    expect(out).toMatchObject({ ok: false, reason: "read_failed" });
    expect((out as { message: string }).message).toBe("Zavi could not connect to this workspace's database.");
  });
});
