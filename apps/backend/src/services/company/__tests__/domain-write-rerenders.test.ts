
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  regenerate: vi.fn(),
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: () => ({ select: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
  tenantRpc: (...a: unknown[]) => mocks.rpc(...(a as [])),
}));
vi.mock("../brief", () => ({ regenerateCompanyBrief: mocks.regenerate }));

import { setCompanyDomain } from "../facts";

describe("setCompanyDomain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.regenerate.mockResolvedValue(true);
  });

  it("re-renders the brief after a successful write", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    const { ok } = await setCompanyDomain("t1", "https://acme.com", "human_confirmed", "test");

    expect(ok).toBe(true);
    expect(mocks.regenerate).toHaveBeenCalledWith("t1");
  });

  it("does not re-render when the write was rejected", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "private host" } });
    const { ok, error } = await setCompanyDomain("t1", "https://169.254.169.254", "human_confirmed", "test");

    expect(ok).toBe(false);
    expect(error).toBe("private host");
    expect(mocks.regenerate).not.toHaveBeenCalled();
  });

  it("re-renders when the domain is cleared", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    await setCompanyDomain("t1", null, "human_confirmed", "test");

    expect(mocks.regenerate).toHaveBeenCalledWith("t1");
  });

  it("does not throw when the re-render fails", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    mocks.regenerate.mockRejectedValue(new Error("render down"));

    await expect(
      setCompanyDomain("t1", "https://acme.com", "human_confirmed", "test"),
    ).resolves.toEqual({ ok: true, error: null });
  });
});
