
import { describe, it, expect, vi, beforeEach } from "vitest";

let profileData: { beta_invited_at: string | null } | null = null;
let profileError: { message: string } | null = null;

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => ({ data: profileData, error: profileError }),
        }),
      }),
    }),
  }),
}));

import { requireClosedBetaGrant } from "@/services/auth/closedBetaGate";

describe("requireClosedBetaGrant", () => {
  beforeEach(() => {
    profileData = null;
    profileError = null;
    delete process.env.CLOSED_BETA_ENABLED;
  });

  it("grants when beta_invited_at is set", async () => {
    profileData = { beta_invited_at: "2026-05-25T00:00:00Z" };
    const r = await requireClosedBetaGrant("user-1");
    expect(r.ok).toBe(true);
  });

  it("opens by default (env unset) even when beta_invited_at is null", async () => {
    profileData = { beta_invited_at: null };
    const r = await requireClosedBetaGrant("user-1");
    expect(r.ok).toBe(true);
  });

  it("opens by default (env unset) even when profile row absent", async () => {
    profileData = null;
    const r = await requireClosedBetaGrant("user-1");
    expect(r.ok).toBe(true);
  });

  it("blocks when CLOSED_BETA_ENABLED='true' and no invite", async () => {
    process.env.CLOSED_BETA_ENABLED = "true";
    profileData = { beta_invited_at: null };
    const r = await requireClosedBetaGrant("user-1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.code).toBe("closed_beta_required");
      expect(r.message).toContain("cal.com/ravi-ramadasu-wgh4xi/30min");
    }
  });

  it("grants when CLOSED_BETA_ENABLED='true' and beta_invited_at is set", async () => {
    process.env.CLOSED_BETA_ENABLED = "true";
    profileData = { beta_invited_at: "2026-05-25T00:00:00Z" };
    const r = await requireClosedBetaGrant("user-1");
    expect(r.ok).toBe(true);
  });

  it("bypasses gate when CLOSED_BETA_ENABLED=false", async () => {
    process.env.CLOSED_BETA_ENABLED = "false";
    profileData = { beta_invited_at: null };
    const r = await requireClosedBetaGrant("user-1");
    expect(r.ok).toBe(true);
  });

  it("R1 — fails OPEN on profile-read error when gate is enabled (deploy window)", async () => {
    process.env.CLOSED_BETA_ENABLED = "true";
    profileError = { message: "column profiles.beta_invited_at does not exist" };
    const r = await requireClosedBetaGrant("user-1");
    expect(r.ok).toBe(true);
  });
});
