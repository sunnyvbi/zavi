
import { ExpectedToolError } from "@/services/tools/types";
import { asTenantId, tenantClient, tenantStorage } from "@/services/tenant-client";
import { assertSafeUrl, SsrfBlockedError } from "@/services/onboarding/enrichment/url-guard";

const IMAGE_BUCKET = "agent-artifacts";
const IMAGE_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg"]);
export const SIGNED_URL_TTL_S = 15 * 60;

const MAKE_ONE =
  "make one with report__render_social_image (aspect_ratio 1:1 or 4:5) and pass its artifact_id as image_artifact_id, pass a photo the founder attached as its image_path, or use a public https link to a JPG or PNG.";

export type CreativeImageSource = { image_url?: string; image_artifact_id?: string; image_path?: string };

export type ImageArtifactRow = { id: string; storage_path: string; bucket: string | null; mime: string | null };

export type CreativeImageDeps = {
  readArtifact: (tenantId: string, id: string) => Promise<ImageArtifactRow | null>;
  sign: (tenantId: string, bucket: string, path: string, ttlS: number) => Promise<string | null>;
  safeUrl: (url: string) => Promise<URL>;
  checkChatImage: (tenantId: string, path: string) => Promise<void>;
  signChatImage: (tenantId: string, path: string, ttlS: number) => Promise<string>;
};

const defaultDeps: CreativeImageDeps = {
  async readArtifact(tenantId, id) {
    const { data, error } = await tenantClient(asTenantId(tenantId)).from("run_artifacts").select("id, storage_path, bucket, mime").eq("id", id).limit(1);
    if (error) throw new ExpectedToolError("reddit_ads_image_unreadable", "The image could not be looked up right now. Try again in a minute.");
    return ((data as ImageArtifactRow[] | null) ?? [])[0] ?? null;
  },
  async sign(tenantId, bucket, path, ttlS) {
    const { data, error } = await tenantStorage(asTenantId(tenantId)).from(bucket).createSignedUrl(path, ttlS);
    return error || !data?.signedUrl ? null : data.signedUrl;
  },
  safeUrl: (url) => assertSafeUrl(url),
  async checkChatImage(tenantId, path) {
    await (await import("@/services/chat-images/sign-own-image")).checkOwnImageForVendor(tenantId, path);
  },
  async signChatImage(tenantId, path, ttlS) {
    return (await import("@/services/chat-images/sign-own-image")).signOwnImageForVendor(tenantId, path, ttlS);
  },
};

async function ownedImage(tenantId: string, artifactId: string, deps: CreativeImageDeps): Promise<ImageArtifactRow | null> {
  const row = await deps.readArtifact(tenantId, artifactId);
  if (!row || row.id !== artifactId) return null;
  if ((row.bucket ?? IMAGE_BUCKET) !== IMAGE_BUCKET) return null;
  if (!IMAGE_MIMES.has(row.mime ?? "")) return null;
  if (!row.storage_path.startsWith(`${tenantId.toLowerCase()}/`) || row.storage_path.includes("..")) return null;
  return row;
}

export async function checkCreativeImage(tenantId: string, src: CreativeImageSource, deps: CreativeImageDeps = defaultDeps): Promise<void> {
  if ([src.image_url, src.image_artifact_id, src.image_path].filter(Boolean).length !== 1) {
    throw new ExpectedToolError("reddit_ads_image_unusable", `Each image ad needs exactly one picture: image_artifact_id, image_path or image_url. Nothing was proposed. Fix: ${MAKE_ONE}`);
  }
  if (src.image_path) {
    try {
      await deps.checkChatImage(tenantId, src.image_path);
    } catch (e) {
      if (!(e instanceof ExpectedToolError)) throw e;
      throw new ExpectedToolError("reddit_ads_image_unusable", `No photo attached in this workspace at ${src.image_path}. Nothing was proposed. Fix: ${MAKE_ONE}`);
    }
    return;
  }
  if (src.image_artifact_id) {
    if (!(await ownedImage(tenantId, src.image_artifact_id, deps))) {
      throw new ExpectedToolError("reddit_ads_image_unusable", `No JPG or PNG image Zavi made with id ${src.image_artifact_id} in this workspace. Nothing was proposed. Fix: ${MAKE_ONE}`);
    }
    return;
  }
  try {
    const u = await deps.safeUrl(src.image_url!);
    if (u.protocol !== "https:") throw new SsrfBlockedError("scheme", "ssrf_scheme");
  } catch (e) {
    if (!(e instanceof SsrfBlockedError)) throw e;
    throw new ExpectedToolError("reddit_ads_image_unusable", `That image link is not a public https address Reddit can download. Nothing was proposed. Fix: ${MAKE_ONE}`);
  }
}

export async function creativeImagePath(tenantId: string, artifactId: string, deps: CreativeImageDeps = defaultDeps): Promise<string | null> {
  return (await ownedImage(tenantId, artifactId, deps))?.storage_path ?? null;
}

export function mediaIsObject(mediaUrl: unknown, storagePath: string, storageOrigin: string | undefined = process.env.SUPABASE_URL, bucket: string = IMAGE_BUCKET): boolean {
  if (typeof mediaUrl !== "string" || !storageOrigin) return false;
  try {
    const u = new URL(mediaUrl);
    const origin = new URL(storageOrigin).origin;
    return u.origin === origin && decodeURIComponent(u.pathname) === `/storage/v1/object/sign/${bucket}/${storagePath}`;
  } catch {
    return false;
  }
}

export async function signCreativeImage(tenantId: string, artifactId: string, deps: CreativeImageDeps = defaultDeps): Promise<string> {
  const row = await ownedImage(tenantId, artifactId, deps);
  if (!row) throw new ExpectedToolError("reddit_ads_invalid_request", `The image ${artifactId} is no longer a Zavi image in this workspace, so Zavi did not create this ad. Fix: ${MAKE_ONE}`);
  const url = await deps.sign(tenantId, IMAGE_BUCKET, row.storage_path, SIGNED_URL_TTL_S);
  if (!url) throw new ExpectedToolError("reddit_ads_image_unreadable", "Zavi's copy of the ad image could not be opened, so nothing was created. Approve the preparation again in a minute.");
  return url;
}

export async function signChatCreativeImage(tenantId: string, path: string, deps: CreativeImageDeps = defaultDeps): Promise<string> {
  try {
    return await deps.signChatImage(tenantId, path, SIGNED_URL_TTL_S);
  } catch (e) {
    if (!(e instanceof ExpectedToolError)) throw e;
    if (e.code === "image_not_owned") throw new ExpectedToolError("reddit_ads_invalid_request", `The photo ${path} is not in this workspace, so Zavi did not create this ad. Fix: ${MAKE_ONE}`);
    throw new ExpectedToolError("reddit_ads_image_unreadable", "The attached photo could not be opened, so nothing was created. Approve again in a minute.");
  }
}
