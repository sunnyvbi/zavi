import { describe, it, expect, vi, beforeEach } from "vitest";

const seen: { table?: string; columns?: string } = {};
const result: { data: unknown; error: unknown } = { data: null, error: null };
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  tenantClient: () => ({
    from: (table: string) => {
      seen.table = table;
      return {
        select: (columns: string) => {
          seen.columns = columns;
          return { maybeSingle: async () => result };
        },
      };
    },
  }),
}));

import { realResolveWorkspaceName } from "@/services/agents/start-product-build";

describe("realResolveWorkspaceName", () => {
  beforeEach(() => {
    result.data = null;
    result.error = null;
  });

  it("reads the workspace's display_name", async () => {
    result.data = { display_name: "  Apna Tutor " };
    expect(await realResolveWorkspaceName("6fcb0904-4e2b-41dc-aa92-83810a902d2d")).toBe("Apna Tutor");
    expect(seen).toEqual({ table: "tenants", columns: "display_name" });
  });

  it("an empty name is null, and a read error throws (the caller treats it as unknown)", async () => {
    result.data = { display_name: "  " };
    expect(await realResolveWorkspaceName("t")).toBeNull();
    result.error = { message: "column tenants.name does not exist" };
    await expect(realResolveWorkspaceName("t")).rejects.toThrow(/tenants display_name read failed/);
  });
});
