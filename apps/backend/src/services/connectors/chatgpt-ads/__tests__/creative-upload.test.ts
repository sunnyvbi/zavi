import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ upload: vi.fn(), row: null as null | { input_hash: string; file_id: string | null }, scope: [] as unknown[] }));
vi.mock("../http", () => ({ chatgptAdsPost: m.upload }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: () => {
  const q = {
    upsert: (rows: Array<{ input_hash: string }>) => { m.row ??= { input_hash: rows[0].input_hash, file_id: null }; return Promise.resolve({ error: null }); },
    select: () => q,
    eq: (key: string, val: unknown) => { if (key === "tenant_id") m.scope.push(val); return q; },
    single: async () => ({ data: m.row, error: null }),
    update: (value: { file_id: string }) => { if (m.row && !m.row.file_id) m.row.file_id = value.file_id; return q; },
    is: () => Promise.resolve({ error: null }),
  }; return q;
} }) }));
import { stableCreativeUpload } from "../creative-upload";
beforeEach(() => { vi.resetAllMocks(); m.row = null; m.scope.length = 0; m.upload.mockResolvedValue({ file_id: "file-stable" }); });
it("persists and reuses the image on a create retry so the provider body cannot change", async () => {
  const input = { image_url: "https://client.example/image.png", title: "Example" };
  expect(await stableCreativeUpload("tenant-a", "key-a", input, "api-key", input.image_url)).toEqual({ file_id: "file-stable" });
  expect(await stableCreativeUpload("tenant-a", "key-a", input, "api-key", input.image_url)).toEqual({ file_id: "file-stable" });
  expect(m.upload).toHaveBeenCalledTimes(1); expect(m.scope.every(t => t === "tenant-a")).toBe(true);
});
it("refuses the same request key with changed ad contents before another upload", async () => {
  await stableCreativeUpload("tenant-a", "key-a", { image_url: "https://client.example/image.png", title: "First" }, "api-key", "https://client.example/image.png");
  await expect(stableCreativeUpload("tenant-a", "key-a", { image_url: "https://client.example/image.png", title: "Changed" }, "api-key", "https://client.example/image.png")).rejects.toMatchObject({ code: "chatgpt_ads_conflict" });
  expect(m.upload).toHaveBeenCalledTimes(1);
});
it.each([
  { image_path: "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg", title: "Example" },
  { image_artifact_id: "a51bf6d9-cb5b-4959-97ab-42bb8480319a", title: "Example" },
])("a private image retried with a fresh signed link is the same request and uploads once: %j", async (input) => {
  const tenant = "11111111-1111-4111-8111-111111111111";
  expect(await stableCreativeUpload(tenant, "key-p", input, "api-key", "https://storage.example/sign?token=first")).toEqual({ file_id: "file-stable" });
  expect(await stableCreativeUpload(tenant, "key-p", input, "api-key", "https://storage.example/sign?token=second")).toEqual({ file_id: "file-stable" });
  expect(m.upload).toHaveBeenCalledTimes(1);
  expect(m.upload).toHaveBeenCalledWith("api-key", "/upload", { image_url: "https://storage.example/sign?token=first" });
});
