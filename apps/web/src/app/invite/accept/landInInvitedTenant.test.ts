import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { landInInvitedTenant } from "./landInInvitedTenant";

const USER = "00000000-0000-4000-8000-000000000001";
const INVITED = "00000000-0000-4000-8000-0000000000b0";
const PREVIOUS = "00000000-0000-4000-8000-0000000000a0";

function fakeSupabase(profileTenant: string | null): SupabaseClient {
  const rows: Record<string, Record<string, unknown>[]> = {
    profiles: [{ user_id: USER, active_tenant_id: profileTenant }],
    tenants: [
      { id: INVITED, display_name: "Invited Co" },
      { id: PREVIOUS, display_name: "Previous Co" },
    ],
    tenant_users: [
      { user_id: USER, tenant_id: INVITED, role: "admin" },
      { user_id: USER, tenant_id: PREVIOUS, role: "owner" },
    ],
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
    from(table: string) {
      const filters: [string, unknown][] = [];
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return q;
        },
        maybeSingle: async () => ({
          data: rows[table].find((r) => filters.every(([c, v]) => r[c] === v)) ?? null,
          error: null,
        }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

describe("landInInvitedTenant", () => {
  it("accepting an invite from a session pinned to another company switches to and names Invited Co", async () => {
    const switchTo = vi.fn(async () => true);
    const landed = await landInInvitedTenant(fakeSupabase(INVITED), USER, switchTo);
    expect(switchTo).toHaveBeenCalledWith(INVITED);
    expect(landed).toEqual({
      tenant_id: INVITED,
      tenant_name: "Invited Co",
      role: "admin",
      switched: true,
    });
  });

  it("still names the invited company when the switch fails, and reports it did not switch", async () => {
    const landed = await landInInvitedTenant(fakeSupabase(INVITED), USER, async () => false);
    expect(landed?.tenant_name).toBe("Invited Co");
    expect(landed?.switched).toBe(false);
  });

  it("treats a throwing switch as not switched", async () => {
    const landed = await landInInvitedTenant(fakeSupabase(INVITED), USER, async () => {
      throw new Error("network");
    });
    expect(landed?.switched).toBe(false);
  });

  it("returns null and does not switch when the profile has no active tenant", async () => {
    const switchTo = vi.fn(async () => true);
    expect(await landInInvitedTenant(fakeSupabase(null), USER, switchTo)).toBeNull();
    expect(switchTo).not.toHaveBeenCalled();
  });
});
