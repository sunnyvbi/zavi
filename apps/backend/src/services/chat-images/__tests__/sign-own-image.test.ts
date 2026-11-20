import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ sign: vi.fn(), exists: vi.fn(), bucket: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantStorage: () => ({ from: (bucket: string) => { m.bucket(bucket); return { createSignedUrl: m.sign, exists: m.exists }; } }),
}));
import { checkOwnImageForVendor, signOwnImageForVendor, VENDOR_FETCH_TTL_SECONDS } from "../sign-own-image";

const tenant = "11111111-1111-4111-8111-111111111111";
const own = `${tenant}/33333333-3333-4333-8333-333333333333.jpg`;
beforeEach(() => { vi.resetAllMocks(); m.sign.mockResolvedValue({ data: { signedUrl: "https://storage.example/signed" }, error: null }); m.exists.mockResolvedValue({ data: true, error: null }); });

it("checks the uploaded object's existence without signing a link", async () => {
  await expect(checkOwnImageForVendor(tenant, own)).resolves.toBeUndefined();
  expect(m.bucket).toHaveBeenCalledWith("agent-chat-images");
  expect(m.exists).toHaveBeenCalledWith(own);
  expect(m.sign).not.toHaveBeenCalled();
});
it.each([null, { status: 400 }, { status: 404 }])("identifies a deleted upload without asking for public hosting: %j", async error => {
  m.exists.mockResolvedValue({ data: false, error });
  await expect(checkOwnImageForVendor(tenant, own)).rejects.toMatchObject({ code: "image_unavailable", message: expect.stringContaining("no longer available") });
});
it.each(["returned", "thrown"])("reports a %s storage outage as retryable with the same image", async kind => {
  if (kind === "returned") m.exists.mockResolvedValue({ data: false, error: { status: 503 } });
  else m.exists.mockRejectedValue(new Error("offline"));
  await expect(checkOwnImageForVendor(tenant, own)).rejects.toMatchObject({ code: "image_unavailable", message: expect.stringContaining("Retry with the same image") });
});

it("signs the workspace's own image in the chat bucket for a short time", async () => {
  expect(await signOwnImageForVendor(tenant, own)).toBe("https://storage.example/signed");
  expect(m.bucket).toHaveBeenCalledWith("agent-chat-images");
  expect(m.sign).toHaveBeenCalledWith(own, VENDOR_FETCH_TTL_SECONDS);
});
it.each([
  ["another workspace's image", `22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.jpg`],
  ["a path climbing out of the folder", `${tenant}/../22222222-2222-4222-8222-222222222222/x.jpg`],
  ["a nested path", `${tenant}/44444444-4444-4444-8444-444444444444/33333333-3333-4333-8333-333333333333.jpg`],
  ["another bucket's prefix", `agent-artifacts/${own}`],
  ["a png", `${tenant}/33333333-3333-4333-8333-333333333333.png`],
  ["a link", "https://evil.example/x.jpg"],
])("refuses %s without touching storage", async (_why, path) => {
  await expect(signOwnImageForVendor(tenant, path)).rejects.toMatchObject({ code: "image_not_owned" });
  await expect(checkOwnImageForVendor(tenant, path)).rejects.toMatchObject({ code: "image_not_owned" });
  expect(m.sign).not.toHaveBeenCalled();
  expect(m.exists).not.toHaveBeenCalled();
});
it("matches the tenant id case-insensitively but nothing looser", async () => {
  await expect(signOwnImageForVendor(tenant.toUpperCase(), own)).resolves.toBe("https://storage.example/signed");
});
it("says the image is unavailable when storage cannot sign it", async () => {
  m.sign.mockResolvedValue({ data: null, error: { message: "not found" } });
  await expect(signOwnImageForVendor(tenant, own)).rejects.toMatchObject({ code: "image_unavailable" });
});
