import { describe, expect, it } from "vitest";
import { asTenantId, tenantRpc } from "@/services/tenant-client";

describe("set_channel_action_steps is a registered tenant RPC", () => {
  it("does not throw the not-registered error", () => {
    let message = "";
    try {
      void tenantRpc(asTenantId("73db45ff-457e-4541-bc8f-bdb625390204"), "set_channel_action_steps", {});
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).not.toMatch(/not in the tenant-RPC registry/);
  });

  it("the check itself works: an unknown RPC does throw it", () => {
    expect(() => tenantRpc(asTenantId("73db45ff-457e-4541-bc8f-bdb625390204"), "no_such_rpc_x", {})).toThrow(/not in the tenant-RPC registry/);
  });
});
