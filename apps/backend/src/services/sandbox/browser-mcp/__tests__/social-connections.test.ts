import { describe, it, expect, beforeEach, vi } from "vitest";

const { getSecret, rpc, fromState } = vi.hoisted(() => ({
  getSecret: vi.fn(),
  rpc: vi.fn(),
  fromState: {
    result: { data: null as unknown, error: null as unknown },
    filters: {} as Record<string, unknown>,
  },
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret }));
vi.mock("@/services/supabase", () => {
  const makeBuilder = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    b.select = self;
    b.not = self;
    b.update = self;
    b.limit = self;
    b.eq = (col: string, val: unknown) => {
      fromState.filters[col] = val;
      return b;
    };
    b.maybeSingle = async () => fromState.result;
    (b as { then: unknown }).then = (
      resolve: (v: unknown) => unknown,
    ) => resolve(fromState.result);
    return b;
  };
  return { serviceClient: () => ({ rpc, from: () => makeBuilder() }) };
});

import {
  getSocialCredentials,
  setSocialConnection,
  getConnectedSocialAccount,
  tenantHasConnectedProfileForOrigin,
} from "../social-connections";

const OWNER = "user-A";
const OTHER = "user-B";

beforeEach(() => {
  getSecret.mockReset();
  rpc.mockReset();
  fromState.result = { data: null, error: null };
  fromState.filters = {};
});

describe("getSocialCredentials — owner-scoped (Gap3/D1)", () => {
  it("owner match → resolves the owned row FIRST, then reads Vault", async () => {
    fromState.result = { data: [{ id: "row-1" }], error: null };
    getSecret
      .mockResolvedValueOnce("upcarofficial")
      .mockResolvedValueOnce("s3cret");
    const creds = await getSocialCredentials(
      "t1",
      "instagram",
      "upcarofficial",
      OWNER,
    );
    expect(creds).toEqual({ username: "upcarofficial", password: "s3cret" });
    expect(fromState.filters.owner_user_id).toBe(OWNER);
    expect(getSecret).toHaveBeenNthCalledWith(
      1,
      "t1",
      "social.instagram.upcarofficial.username",
    );
  });

  it("QA#1 (incident replay) — a NON-owner reads NO creds; Vault is never touched", async () => {
    fromState.result = { data: [], error: null };
    const creds = await getSocialCredentials(
      "t1",
      "instagram",
      "upcarofficial",
      OTHER,
    );
    expect(creds).toBeNull();
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("QA#4 (fail-closed) — no attributable user → NO creds, Vault untouched", async () => {
    const creds = await getSocialCredentials(
      "t1",
      "instagram",
      "upcarofficial",
      undefined,
    );
    expect(creds).toBeNull();
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("owner match but a secret missing → null (not fully connected)", async () => {
    fromState.result = { data: [{ id: "row-1" }], error: null };
    getSecret.mockResolvedValueOnce("upcarofficial").mockResolvedValueOnce(null);
    expect(
      await getSocialCredentials("t1", "instagram", "upcarofficial", OWNER),
    ).toBeNull();
  });
});

describe("getConnectedSocialAccount — owner + tenant scoped", () => {
  it("resolves an OWNED connected account for the origin's platform", async () => {
    fromState.result = {
      data: { handle: "upcarofficial", anchor_profile_id: "prof-9" },
      error: null,
    };
    const acct = await getConnectedSocialAccount(
      "t1",
      "https://www.instagram.com/x",
      OWNER,
    );
    expect(acct).toEqual({
      platform: "instagram",
      handle: "upcarofficial",
      anchor_profile_id: "prof-9",
    });
    expect(fromState.filters.tenant_id).toBe("t1");
    expect(fromState.filters.owner_user_id).toBe(OWNER);
    expect(fromState.filters.platform).toBe("instagram");
  });

  it("QA#4 fail-closed — no owner → null WITHOUT querying", async () => {
    const acct = await getConnectedSocialAccount(
      "t1",
      "https://www.instagram.com/x",
      undefined,
    );
    expect(acct).toBeNull();
    expect(fromState.filters).toEqual({});
  });

  it("non-social origin → null", async () => {
    expect(
      await getConnectedSocialAccount("t1", "https://example.com", OWNER),
    ).toBeNull();
  });
});

describe("tenantHasConnectedProfileForOrigin — owner scoped", () => {
  it("true only for an OWNED connected+resumable row", async () => {
    fromState.result = { data: [{ anchor_profile_id: "p1" }], error: null };
    const ok = await tenantHasConnectedProfileForOrigin(
      "t1",
      "https://www.linkedin.com/feed",
      OWNER,
    );
    expect(ok).toBe(true);
    expect(fromState.filters.owner_user_id).toBe(OWNER);
  });

  it("fail-closed — no owner → false without querying", async () => {
    const ok = await tenantHasConnectedProfileForOrigin(
      "t1",
      "https://www.linkedin.com/feed",
      undefined,
    );
    expect(ok).toBe(false);
    expect(fromState.filters).toEqual({});
  });
});

describe("setSocialConnection — passes owner to the RPC", () => {
  it("maps owner_user_id → p_owner_user_id", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await setSocialConnection({
      tenant_id: "t1",
      platform: "linkedin",
      handle: "upcar",
      username: "u",
      password: "p",
      owner_user_id: OWNER,
      anchor_profile_id: "prof-1",
    });
    expect(rpc).toHaveBeenCalledWith("set_social_connection", {
      p_tenant_id: "t1",
      p_platform: "linkedin",
      p_handle: "upcar",
      p_username: "u",
      p_password: "p",
      p_owner_user_id: OWNER,
      p_anchor_profile_id: "prof-1",
    });
  });

  it("throws when the RPC errors", async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "handle already connected by another member" },
    });
    await expect(
      setSocialConnection({
        tenant_id: "t1",
        platform: "instagram",
        handle: "x",
        username: "u",
        password: "p",
        owner_user_id: OWNER,
      }),
    ).rejects.toThrow(/set_social_connection failed/);
  });
});
