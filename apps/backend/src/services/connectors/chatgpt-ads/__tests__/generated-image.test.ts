import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ read: vi.fn(), eq: vi.fn(), sign: vi.fn(), exists: vi.fn(), db: vi.fn(), storage: vi.fn(), bucket: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: m.db,
  tenantStorage: m.storage,
}));
import { checkGeneratedAdImage, signGeneratedAdImage } from "../generated-image";
import { safeFilename } from "@/services/reports/image-filename";

const tenant = "11111111-1111-4111-8111-111111111111";
const artifact = "a51bf6d9-cb5b-4959-97ab-42bb8480319a";
const path = `${tenant}/22222222-2222-4222-8222-222222222222/upcar-chatgpt-rent-cheap.png`;
const row = { id: artifact, storage_path: path, bucket: null, mime: "image/png" };

beforeEach(() => {
  vi.resetAllMocks();
  m.eq.mockReturnValue({ maybeSingle: m.read });
  m.db.mockReturnValue({ from: () => ({ select: () => ({ eq: m.eq }) }) });
  m.read.mockResolvedValue({ data: row, error: null });
  m.bucket.mockReturnValue({ createSignedUrl: m.sign, exists: m.exists });
  m.exists.mockResolvedValue({ data: true, error: null });
  m.storage.mockReturnValue({ from: m.bucket });
  m.sign.mockResolvedValue({ data: { signedUrl: "https://storage.example/temporary" }, error: null });
});

it("checks the generated PNG in the caller's tenant without signing or publishing at proposal time", async () => {
  await checkGeneratedAdImage(tenant, artifact);
  expect(m.db).toHaveBeenCalledWith(tenant);
  expect(m.eq).toHaveBeenCalledWith("id", artifact);
  expect(m.exists).toHaveBeenCalledWith(path);
  expect(m.sign).not.toHaveBeenCalled();
});

it.each([
  null,
  { ...row, id: "other" },
  { ...row, storage_path: path.replace(tenant, "33333333-3333-4333-8333-333333333333") },
  { ...row, bucket: "agent-chat-images" },
  { ...row, bucket: "documents" },
  { ...row, mime: "image/svg+xml" },
  { ...row, mime: "application/pdf" },
  { ...row, storage_path: `${tenant}/../../other.png` },
  { ...row, storage_path: path.replace("cheap.png", "../secret.png") },
  { ...row, storage_path: path.replace(".png", ".html") },
])("refuses missing, foreign and unusable artifacts before signing: %j", async (data) => {
  m.read.mockResolvedValue({ data, error: null });
  await expect(signGeneratedAdImage(tenant, artifact)).rejects.toMatchObject({ code: "image_not_owned" });
  expect(m.storage).not.toHaveBeenCalled();
});

it("rechecks ownership and signs only the stored path for 15 minutes at upload", async () => {
  await checkGeneratedAdImage(tenant, artifact);
  expect(await signGeneratedAdImage(tenant, artifact)).toBe("https://storage.example/temporary");
  expect(m.read).toHaveBeenCalledTimes(2);
  expect(m.storage).toHaveBeenCalledWith(tenant);
  expect(m.bucket).toHaveBeenCalledWith("agent-artifacts");
  expect(m.sign).toHaveBeenCalledWith(path, 900);
});

it("refuses an image deleted after proposal without signing it", async () => {
  await checkGeneratedAdImage(tenant, artifact);
  m.read.mockResolvedValue({ data: null, error: null });
  await expect(signGeneratedAdImage(tenant, artifact)).rejects.toMatchObject({ code: "image_not_owned" });
  expect(m.exists).toHaveBeenCalledOnce();
  expect(m.sign).not.toHaveBeenCalled();
});

it("accepts JPEG artifacts too", async () => {
  m.read.mockResolvedValue({ data: { ...row, bucket: "agent-artifacts", mime: "image/jpeg", storage_path: path.replace(".png", ".jpg") }, error: null });
  await expect(checkGeneratedAdImage(tenant, artifact)).resolves.toBeUndefined();
});

it.each(["Car.PNG", "Upcar-Rentals.JPEG", "car..v2.png"])("accepts the generator's actual filename contract: %s", async filename => {
  const storagePath = path.replace(/[^/]+$/, safeFilename(filename, 0));
  m.read.mockResolvedValue({ data: { ...row, storage_path: storagePath }, error: null });
  await expect(checkGeneratedAdImage(tenant, artifact)).resolves.toBeUndefined();
  await signGeneratedAdImage(tenant, artifact);
  expect(m.sign).toHaveBeenCalledWith(storagePath, 900);
});

it("refuses a missing storage object even when its artifact record remains", async () => {
  m.exists.mockResolvedValue({ data: false, error: { status: 404 } });
  await expect(checkGeneratedAdImage(tenant, artifact)).rejects.toMatchObject({ code: "image_unavailable" });
  expect(m.sign).not.toHaveBeenCalled();
});

it("reports lookup and signing outages as recoverable failures", async () => {
  m.read.mockResolvedValueOnce({ data: null, error: { message: "offline" } });
  await expect(checkGeneratedAdImage(tenant, artifact)).rejects.toMatchObject({ code: "image_unavailable" });
  expect(m.storage).not.toHaveBeenCalled();
  m.sign.mockResolvedValue({ data: null, error: { message: "offline" } });
  await expect(signGeneratedAdImage(tenant, artifact)).rejects.toMatchObject({ code: "image_unavailable" });
});
