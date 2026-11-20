import { describe, it, expect, vi, beforeEach } from "vitest";
import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

const readTenantDisabled = vi.fn();
vi.mock("@/services/tenants/disabled", () => ({
  readTenantDisabled: (id: string) => readTenantDisabled(id),
  TENANT_DISABLED_MESSAGE: "This workspace is disabled. Contact support@zaviagent.com.",
}));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/auth/pat", () => ({
  isPatToken: (raw: string) => raw.startsWith("zavi_pat_"),
  resolveCallerFromPat: vi.fn(async () => ({
    tenant_id: "t1",
    user_id: "u1",
    scopes: ["read"],
    pat_id: "p1",
  })),
  _verifyHashConstantTime: vi.fn(),
}));

import { verifyAccessToken, TenantDisabledTokenError } from "../verifier";

describe("verifyAccessToken: disabled workspace", () => {
  beforeEach(() => readTenantDisabled.mockReset());

  it("lets a token for a live workspace through", async () => {
    readTenantDisabled.mockResolvedValue(false);
    const auth = await verifyAccessToken("zavi_pat_abc");
    expect(auth.extra?.tenant_id).toBe("t1");
    expect(readTenantDisabled).toHaveBeenCalledWith("t1");
  });

  it("refuses a token once the workspace is disabled, as a 401 to the SDK", async () => {
    readTenantDisabled.mockResolvedValue(true);
    const err = await verifyAccessToken("zavi_pat_abc").catch((e) => e);
    expect(err).toBeInstanceOf(TenantDisabledTokenError);
    expect(err).toBeInstanceOf(InvalidTokenError);
  });

  it("answers a 5xx, not a pass or a 401, when the flag cannot be read", async () => {
    readTenantDisabled.mockResolvedValue(null);
    const err = await verifyAccessToken("zavi_pat_abc").catch((e) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect(err).not.toBeInstanceOf(InvalidTokenError);
  });
});
