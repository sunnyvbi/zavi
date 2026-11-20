import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  cname: vi.fn(),
}));

vi.mock("../render-custom-domain", () => ({
  attachRenderCustomDomain: (...a: unknown[]) => mocks.attach(...a),
  detachRenderCustomDomain: (...a: unknown[]) => mocks.detach(...a),
}));
vi.mock("../cloudflare-dns", () => ({
  BUILTIN_HOST_IN_USE: "that domain is already in use by another app",
  ensureDnsCname: (...a: unknown[]) => mocks.cname(...a),
  deleteDnsCname: vi.fn(),
}));

import { setBuiltinSubdomain } from "../builtin-url";

describe("setBuiltinSubdomain — a refused DNS write leaves nothing attached", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detach.mockResolvedValue(undefined);
    mocks.cname.mockRejectedValue(new Error("that domain is already in use by another app"));
  });

  it("detaches the Render domain this call attached, then rethrows", async () => {
    mocks.attach.mockResolvedValue({ custom_domain_id: "cd-new", already: false });
    await expect(setBuiltinSubdomain("srv-1", "https://x.onrender.com", "growth")).rejects.toThrow("already in use");
    expect(mocks.detach).toHaveBeenCalledWith("srv-1", "cd-new");
  });

  it("keeps the attach on an ordinary DNS failure, for a retry", async () => {
    mocks.attach.mockResolvedValue({ custom_domain_id: "cd-new", already: false });
    mocks.cname.mockRejectedValue(new Error("cloudflare dns create failed (500): boom"));
    await expect(setBuiltinSubdomain("srv-1", "https://x.onrender.com", "cool")).rejects.toThrow("500");
    expect(mocks.detach).not.toHaveBeenCalled();
  });

  it("leaves an attachment that already existed before this call", async () => {
    mocks.attach.mockResolvedValue({ custom_domain_id: "cd-old", already: true });
    await expect(setBuiltinSubdomain("srv-1", "https://x.onrender.com", "growth")).rejects.toThrow("already in use");
    expect(mocks.detach).not.toHaveBeenCalled();
  });
});
