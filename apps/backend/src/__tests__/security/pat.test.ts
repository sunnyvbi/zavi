import { describe, it, expect, beforeEach, vi } from "vitest";

type PatRow = {
  id: string;
  user_id: string;
  tenant_id: string;
  token_hash: string;
  token_salt: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
};

const state = vi.hoisted(() => ({
  patRows: [] as PatRow[],
  patSelectError: null as unknown,
  liveMembership: null as { tenant_id: string } | null,
  membershipError: null as unknown,
  membershipQuery: { user_id: "", tenant_id: "" },
  updateCalled: false,
}));

vi.mock("@/services/supabase", () => {
  function patChain() {
    return {
      select: () => ({
        eq: (_col: string, _val: string) => ({
          is: (_c: string, _v: null) =>
            Promise.resolve({ data: state.patRows, error: state.patSelectError }),
        }),
      }),
      update: () => ({
        eq: () => {
          state.updateCalled = true;
          return Promise.resolve({ error: null });
        },
      }),
    };
  }
  function tenantUsersChain() {
    return {
      select: () => ({
        eq: (_c1: string, userId: string) => ({
          eq: (_c2: string, tenantId: string) => ({
            maybeSingle: () => {
              state.membershipQuery = { user_id: userId, tenant_id: tenantId };
              return Promise.resolve({
                data: state.liveMembership,
                error: state.membershipError,
              });
            },
          }),
        }),
      }),
    };
  }
  return {
    serviceClient: () => ({
      from: (table: string) =>
        table === "tenant_pats" ? patChain() : tenantUsersChain(),
      rpc: async () => ({ data: "new-id", error: null }),
    }),
  };
});

import {
  resolveCallerFromPat,
  hashPatToken,
  generateRawPat,
  _verifyHashConstantTime,
  isPatToken,
  PAT_PREFIX,
  LEGACY_PAT_PREFIX,
  PatAuthError,
} from "@/services/auth/pat";

const SALT = "deadbeefcafef00d";

function makeRow(raw: string, overrides: Partial<PatRow> = {}): PatRow {
  return {
    id: "pat-1",
    user_id: "user-A",
    tenant_id: "tenant-ADVISORY",
    token_hash: hashPatToken(raw, SALT),
    token_salt: SALT,
    scopes: ["read", "run"],
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  state.patRows = [];
  state.patSelectError = null;
  state.liveMembership = { tenant_id: "tenant-LIVE" };
  state.membershipError = null;
  state.membershipQuery = { user_id: "", tenant_id: "" };
  state.updateCalled = false;
});

describe("resolveCallerFromPat — malformed-token rejection (cheap, before any DB hit)", () => {
  it.each([
    ["empty", ""],
    ["wrong prefix", "github_pat_" + "a".repeat(40)],
    ["too short (current prefix)", PAT_PREFIX + "abc"],
    ["too short (legacy prefix)", LEGACY_PAT_PREFIX + "abc"],
  ])("rejects %s with PatAuthError(malformed)", async (_label, raw) => {
    await expect(resolveCallerFromPat(raw)).rejects.toMatchObject({ code: "malformed" });
  });
});

describe("PAT prefix — zavi_ is minted, praxis_ is still accepted", () => {
  it("mints tokens under the zavi_ prefix, never the legacy one", () => {
    const raw = generateRawPat();
    expect(raw.startsWith(PAT_PREFIX)).toBe(true);
    expect(raw.startsWith(LEGACY_PAT_PREFIX)).toBe(false);
  });

  it("isPatToken accepts BOTH prefixes and rejects anything else", () => {
    expect(isPatToken(PAT_PREFIX + "a".repeat(64))).toBe(true);
    expect(isPatToken(LEGACY_PAT_PREFIX + "a".repeat(64))).toBe(true);
    expect(isPatToken("praxis_oat_" + "a".repeat(64))).toBe(false);
    expect(isPatToken("github_pat_" + "a".repeat(64))).toBe(false);
    expect(isPatToken("")).toBe(false);
  });

  it("both prefixes yield a 23-char lookup slice", () => {
    const zavi = PAT_PREFIX + "b".repeat(64);
    const legacy = LEGACY_PAT_PREFIX + "b".repeat(64);
    expect(zavi.slice(0, 23)).toHaveLength(23);
    expect(legacy.slice(0, 23)).toHaveLength(23);
  });

  it("authenticates a LEGACY-prefixed token end to end", async () => {
    const legacyRaw = LEGACY_PAT_PREFIX + "c".repeat(64);
    state.patRows = [makeRow(legacyRaw)];
    state.liveMembership = { tenant_id: "tenant-live" };
    const caller = await resolveCallerFromPat(legacyRaw);
    expect(caller.tenant_id).toBe("tenant-live");
  });
});

describe("resolveCallerFromPat — not_found paths", () => {
  it("rejects when no prefix candidates exist", async () => {
    state.patRows = [];
    const raw = generateRawPat();
    await expect(resolveCallerFromPat(raw)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects when a candidate exists but the hash does not match (no token leak)", async () => {
    const real = generateRawPat();
    const attacker = generateRawPat();
    state.patRows = [makeRow(real)];
    await expect(resolveCallerFromPat(attacker)).rejects.toMatchObject({ code: "not_found" });
  });

  it("propagates a DB select error as not_found (fail-closed)", async () => {
    state.patSelectError = { message: "boom" };
    await expect(resolveCallerFromPat(generateRawPat())).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("resolveCallerFromPat — >5 same-prefix candidates → anomaly (brute-force/timing guard)", () => {
  it("rejects with anomaly when more than 5 rows share the prefix", async () => {
    const raw = generateRawPat();
    state.patRows = Array.from({ length: 6 }, (_, i) =>
      makeRow(i === 0 ? raw : generateRawPat(), { id: `pat-${i}` }),
    );
    await expect(resolveCallerFromPat(raw)).rejects.toMatchObject({ code: "anomaly" });
  });

  it("ALLOWS exactly 5 candidates (boundary — cap is >5, not >=5)", async () => {
    const raw = generateRawPat();
    state.patRows = Array.from({ length: 5 }, (_, i) =>
      makeRow(i === 0 ? raw : generateRawPat(), { id: `pat-${i}` }),
    );
    const caller = await resolveCallerFromPat(raw);
    expect(caller.user_id).toBe("user-A");
  });
});

describe("resolveCallerFromPat — expiry / revocation", () => {
  it("rejects an expired PAT", async () => {
    const raw = generateRawPat();
    const past = new Date(Date.now() - 60_000).toISOString();
    state.patRows = [makeRow(raw, { expires_at: past })];
    await expect(resolveCallerFromPat(raw)).rejects.toMatchObject({ code: "expired" });
  });

  it("accepts a PAT whose expiry is in the future", async () => {
    const raw = generateRawPat();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    state.patRows = [makeRow(raw, { expires_at: future })];
    const caller = await resolveCallerFromPat(raw);
    expect(caller.pat_id).toBe("pat-1");
  });

  it("rejects (membership_revoked) when the user is no longer a member of the tenant", async () => {
    const raw = generateRawPat();
    state.patRows = [makeRow(raw)];
    state.liveMembership = null;
    await expect(resolveCallerFromPat(raw)).rejects.toMatchObject({ code: "membership_revoked" });
  });
});

describe("resolveCallerFromPat — LIVE tenant re-derive (THE trust boundary)", () => {
  it("returns the LIVE tenant from tenant_users, NOT the advisory tenant_pats.tenant_id", async () => {
    const raw = generateRawPat();
    state.patRows = [makeRow(raw, { tenant_id: "tenant-ADVISORY" })];
    state.liveMembership = { tenant_id: "tenant-LIVE" };
    const caller = await resolveCallerFromPat(raw);
    expect(caller.tenant_id).toBe("tenant-LIVE");
    expect(caller.tenant_id).not.toBe("tenant-ADVISORY");
  });

  it("re-derives membership by querying (user_id, advisory tenant_id) against tenant_users", async () => {
    const raw = generateRawPat();
    state.patRows = [makeRow(raw, { user_id: "user-A", tenant_id: "tenant-ADVISORY" })];
    await resolveCallerFromPat(raw);
    expect(state.membershipQuery.user_id).toBe("user-A");
    expect(state.membershipQuery.tenant_id).toBe("tenant-ADVISORY");
  });

  it("carries scopes from the stored row (defaults applied at mint, not 'admin')", async () => {
    const raw = generateRawPat();
    state.patRows = [makeRow(raw, { scopes: ["read", "run"] })];
    const caller = await resolveCallerFromPat(raw);
    expect(caller.scopes).toEqual(["read", "run"]);
    expect(caller.scopes).not.toContain("admin");
  });
});

describe("PAT hashing primitives — constant-time compare contract", () => {
  it("hashPatToken is salt-dependent (different salt → different hash)", () => {
    const raw = generateRawPat();
    expect(hashPatToken(raw, "salt-a")).not.toBe(hashPatToken(raw, "salt-b"));
  });

  it("hashPatToken is deterministic for the same (raw, salt)", () => {
    const raw = generateRawPat();
    expect(hashPatToken(raw, SALT)).toBe(hashPatToken(raw, SALT));
  });

  it("_verifyHashConstantTime accepts the correct token", () => {
    const raw = generateRawPat();
    const h = hashPatToken(raw, SALT);
    expect(_verifyHashConstantTime(raw, SALT, h)).toBe(true);
  });

  it("_verifyHashConstantTime rejects a wrong token", () => {
    const raw = generateRawPat();
    const other = generateRawPat();
    const h = hashPatToken(raw, SALT);
    expect(_verifyHashConstantTime(other, SALT, h)).toBe(false);
  });

  it("_verifyHashConstantTime returns false (not throw) on a length-mismatched expected hash", () => {
    const raw = generateRawPat();
    expect(_verifyHashConstantTime(raw, SALT, "abcd")).toBe(false);
  });
});

describe("PatAuthError — code is preserved", () => {
  it("carries the failure code as both .code and .message", () => {
    const e = new PatAuthError("anomaly");
    expect(e.code).toBe("anomaly");
    expect(e.message).toBe("anomaly");
  });
});
