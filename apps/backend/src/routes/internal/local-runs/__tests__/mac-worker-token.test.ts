import { describe, it, expect, beforeEach, vi } from "vitest";

type TokenRow = {
  id: string;
  token_hash: string;
  token_salt: string;
  revoked_at: string | null;
};

const state = vi.hoisted(() => ({
  tokenRows: [] as TokenRow[],
  selectError: null as unknown,
  updateCalled: false,
  masterOn: true,
  canAccess: true as boolean,
  canAccessError: null as unknown,
  lastRpc: { name: "", args: {} as Record<string, unknown> },
}));

vi.mock("@/services/supabase", () => {
  function tokenChain() {
    return {
      select: () => ({
        eq: (_c: string, _v: string) => ({
          is: (_ic: string, _iv: null) =>
            Promise.resolve({
              data: state.tokenRows,
              error: state.selectError,
            }),
        }),
      }),
      update: () => ({
        eq: () => {
          state.updateCalled = true;
          return Promise.resolve({ data: null, error: null });
        },
      }),
    };
  }
  return {
    serviceClient: () => ({
      from: (_t: string) => tokenChain(),
      rpc: (name: string, args: Record<string, unknown>) => {
        state.lastRpc = { name, args };
        return Promise.resolve({
          data: state.canAccess,
          error: state.canAccessError,
        });
      },
    }),
  };
});

vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async () => state.masterOn),
}));

import {
  resolveMacWorkerToken,
  assertTokenTenantEnabled,
  generateRawMacToken,
  hashMacToken,
  MacTokenAuthError,
} from "@/services/auth/mac-worker-token";

beforeEach(() => {
  state.tokenRows = [];
  state.selectError = null;
  state.updateCalled = false;
  state.masterOn = true;
  state.canAccess = true;
  state.canAccessError = null;
  state.lastRpc = { name: "", args: {} };
});

function seedToken(raw: string): { id: string; salt: string } {
  const salt = "deadbeefdeadbeefdeadbeefdeadbeef";
  const hash = hashMacToken(raw, salt);
  const id = "11111111-1111-1111-1111-111111111111";
  state.tokenRows = [{ id, token_hash: hash, token_salt: salt, revoked_at: null }];
  return { id, salt };
}

describe("resolveMacWorkerToken", () => {
  it("round-trips a valid token → {token_id, owner=mac:<id>}", async () => {
    const raw = generateRawMacToken();
    const { id } = seedToken(raw);
    const caller = await resolveMacWorkerToken(raw);
    expect(caller.token_id).toBe(id);
    expect(caller.owner).toBe(`mac:${id}`);
    expect(state.updateCalled).toBe(true);
  });

  it("rejects a token without the zavi_mac_ prefix (malformed)", async () => {
    await expect(resolveMacWorkerToken("praxis_pat_" + "a".repeat(40))).rejects.toMatchObject({
      code: "malformed",
    });
  });

  it("rejects an empty bearer (malformed)", async () => {
    await expect(resolveMacWorkerToken("")).rejects.toBeInstanceOf(MacTokenAuthError);
  });

  it("rejects a too-short token (malformed)", async () => {
    await expect(resolveMacWorkerToken("zavi_mac_abc")).rejects.toMatchObject({
      code: "malformed",
    });
  });

  it("rejects when no row matches the prefix (not_found)", async () => {
    const raw = generateRawMacToken();
    state.tokenRows = [];
    await expect(resolveMacWorkerToken(raw)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects on a hash mismatch even when a same-prefix row exists (not_found)", async () => {
    const raw = generateRawMacToken();
    state.tokenRows = [
      {
        id: "22222222-2222-2222-2222-222222222222",
        token_hash: hashMacToken(generateRawMacToken(), "saltsaltsaltsalt"),
        token_salt: "saltsaltsaltsalt",
        revoked_at: null,
      },
    ];
    await expect(resolveMacWorkerToken(raw)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects with anomaly when >5 prefix candidates share the prefix", async () => {
    const raw = generateRawMacToken();
    state.tokenRows = Array.from({ length: 6 }, (_v, i) => ({
      id: `row-${i}`,
      token_hash: hashMacToken(generateRawMacToken(), "s"),
      token_salt: "s",
      revoked_at: null,
    }));
    await expect(resolveMacWorkerToken(raw)).rejects.toMatchObject({
      code: "anomaly",
    });
  });

  it("treats a select error as not_found (fail-closed)", async () => {
    const raw = generateRawMacToken();
    state.selectError = { message: "db down" };
    await expect(resolveMacWorkerToken(raw)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("assertTokenTenantEnabled (shared fail-closed gate)", () => {
  const TOKEN = "11111111-1111-1111-1111-111111111111";
  const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

  it("returns true when master ON + scoped + lane enabled", async () => {
    state.masterOn = true;
    state.canAccess = true;
    expect(await assertTokenTenantEnabled(TOKEN, TENANT)).toBe(true);
    expect(state.lastRpc.name).toBe("mac_worker_can_access");
    expect(state.lastRpc.args).toMatchObject({
      p_token_id: TOKEN,
      p_tenant_id: TENANT,
    });
  });

  it("returns FALSE when the master switch is off — even if scoped + lane enabled", async () => {
    state.masterOn = false;
    state.canAccess = true;
    expect(await assertTokenTenantEnabled(TOKEN, TENANT)).toBe(false);
    expect(state.lastRpc.name).toBe("");
  });

  it("returns false when the RPC says not-accessible (out-of-scope or lane off)", async () => {
    state.masterOn = true;
    state.canAccess = false;
    expect(await assertTokenTenantEnabled(TOKEN, TENANT)).toBe(false);
  });

  it("fails closed on an RPC error", async () => {
    state.masterOn = true;
    state.canAccessError = { message: "boom" };
    expect(await assertTokenTenantEnabled(TOKEN, TENANT)).toBe(false);
  });
});
