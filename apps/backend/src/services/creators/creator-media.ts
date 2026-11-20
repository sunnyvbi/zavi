
import { randomUUID } from "node:crypto";
import { CREATOR_PHOTO_MAX_BYTES, photoExtensionFor, type CreatorPhotoMime } from "@zavi/shared";
import { humanApplicantStorage } from "@/services/tenant-client";

export const CREATOR_MEDIA_BUCKET = "creator-media";

export const CREATOR_MEDIA_SIGNED_URL_TTL_SECONDS = 60 * 60;

const SAVED_KEY = /^media\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

export function isSavedMediaKey(path: unknown): path is string {
  return typeof path === "string" && SAVED_KEY.test(path);
}

export function newSavedMediaKey(mime: CreatorPhotoMime): string {
  return `media/${randomUUID()}.${photoExtensionFor(mime)}`;
}

export function sniffImageMime(b: Uint8Array): CreatorPhotoMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export async function signCreatorMedia(
  path: string | null | undefined,
  ownerAuthUserId: string | null | undefined,
): Promise<string | null> {
  if (!isSavedMediaKey(path) || !ownerAuthUserId) return null;
  try {
    const { data, error } = await humanApplicantStorage(ownerAuthUserId)
      .from(CREATOR_MEDIA_BUCKET)
      .createSignedUrl(path, CREATOR_MEDIA_SIGNED_URL_TTL_SECONDS);
    if (error) return null;
    return (data as { signedUrl?: string } | null)?.signedUrl ?? null;
  } catch {
    return null;
  }
}

export type AdoptResult = { ok: true; path: string } | { ok: false; reason: "missing" | "too_large" | "not_image" };

export async function adoptUploadedPhoto(authUserId: string, uploadPath: string): Promise<AdoptResult> {
  const bucket = humanApplicantStorage(authUserId).from(CREATOR_MEDIA_BUCKET);
  const cut = uploadPath.lastIndexOf("/");
  const listed = await bucket.list(uploadPath.slice(0, cut), { search: uploadPath.slice(cut + 1), limit: 5 });
  if (listed.error) throw new Error(`creator-media list failed: ${listed.error.message}`);
  const entry = (listed.data ?? []).find((o: { name?: string }) => o.name === uploadPath.slice(cut + 1)) as
    | { metadata?: { size?: number } | null }
    | undefined;
  if (!entry) return { ok: false, reason: "missing" };
  const listedSize = Number(entry.metadata?.size ?? NaN);
  if (Number.isFinite(listedSize) && listedSize > CREATOR_PHOTO_MAX_BYTES) return { ok: false, reason: "too_large" };
  const dl = await bucket.download(uploadPath);
  if (dl.error || !dl.data) {
    const err = dl.error as { message?: string; statusCode?: string | number; status?: number } | null;
    const status = String(err?.statusCode ?? err?.status ?? "");
    if (!err || status === "404" || status === "400" || /not.?found/i.test(err.message ?? "")) {
      return { ok: false, reason: "missing" };
    }
    throw new Error(`creator-media read failed: ${err.message ?? "unknown"}`);
  }
  const blob = dl.data as Blob;
  if (blob.size > CREATOR_PHOTO_MAX_BYTES) return { ok: false, reason: "too_large" };
  const mime = sniffImageMime(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
  if (!mime) return { ok: false, reason: "not_image" };

  const saved = newSavedMediaKey(mime);
  const cp = await bucket.copy(uploadPath, saved);
  if (cp.error) throw new Error(`creator-media copy failed: ${cp.error.message}`);
  return { ok: true, path: saved };
}

export async function discardUpload(authUserId: string, uploadPath: string): Promise<void> {
  try {
    await humanApplicantStorage(authUserId).from(CREATOR_MEDIA_BUCKET).remove([uploadPath]);
  } catch {
  }
}

export async function uploadCreatorImage(authUserId: string, bytes: Uint8Array, mime: string): Promise<string> {
  const declared = (["image/png", "image/jpeg", "image/webp"] as const).find((m) => m === mime);
  const contentType: CreatorPhotoMime = sniffImageMime(bytes) ?? declared ?? "image/png";
  const path = newSavedMediaKey(contentType);
  const { error } = await humanApplicantStorage(authUserId)
    .from(CREATOR_MEDIA_BUCKET)
    .upload(path, Buffer.from(bytes), { contentType, upsert: false });
  if (error) throw new Error(`creator-media upload failed: ${error.message}`);
  return path;
}
