
import { describe, it, expect, vi, beforeEach } from "vitest";

const world = vi.hoisted(() => ({
  members: [] as Array<{ user_id: string; tenant_id: string; role: string; created_at: string }>,
  users: {} as Record<string, { email?: string; email_confirmed_at?: string | null }>,
  memberError: null as null | { message: string },
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (_t: string) => {
      const filters: Record<string, unknown> = {};
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => ((filters[c] = v), q),
        order: () => q,
        limit: () => q,
        maybeSingle: async () => {
          if (world.memberError) return { data: null, error: world.memberError };
          const rows = world.members
            .filter((m) => Object.entries(filters).every(([c, v]) => (m as any)[c] === v))
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
          return { data: rows[0] ? { user_id: rows[0].user_id } : null, error: null };
        },
      };
      return q;
    },
    auth: {
      admin: {
        getUserById: async (id: string) =>
          world.users[id] ? { data: { user: world.users[id] }, error: null } : { data: { user: null }, error: { message: "not found" } },
      },
    },
  }),
}));

import { realResolveOwnerEmail } from "@/services/agents/start-product-build";

beforeEach(() => {
  world.memberError = null;
  world.members = [
    { user_id: "starter", tenant_id: "t1", role: "member", created_at: "2026-09-02" },
    { user_id: "owner", tenant_id: "t1", role: "owner", created_at: "2026-09-01" },
    { user_id: "outsider", tenant_id: "t2", role: "owner", created_at: "2026-09-01" },
  ];
  world.users = {
    starter: { email: "Starter@Example.com", email_confirmed_at: "2026-09-02" },
    owner: { email: "owner@example.com", email_confirmed_at: "2026-09-01" },
    outsider: { email: "outsider@example.com", email_confirmed_at: "2026-09-01" },
  };
});

describe("realResolveOwnerEmail", () => {
  it("uses the starter's verified email", async () => {
    expect(await realResolveOwnerEmail("t1", "starter")).toBe("starter@example.com");
  });

  it("falls back to the tenant owner when the starter is unverified", async () => {
    world.users.starter.email_confirmed_at = null;
    expect(await realResolveOwnerEmail("t1", "starter")).toBe("owner@example.com");
  });

  it("never uses a user who is not a member of the tenant", async () => {
    expect(await realResolveOwnerEmail("t1", "outsider")).toBe("owner@example.com");
  });

  it("with no user, uses the tenant owner", async () => {
    expect(await realResolveOwnerEmail("t1", null)).toBe("owner@example.com");
  });

  it("returns null when no verified email exists", async () => {
    world.users.owner.email_confirmed_at = null;
    expect(await realResolveOwnerEmail("t1", null)).toBeNull();
  });

  it("throws on a read error (the branch maps it to no pre-registered admin)", async () => {
    world.memberError = { message: "db down" };
    await expect(realResolveOwnerEmail("t1", "starter")).rejects.toThrow(/db down/);
  });
});
