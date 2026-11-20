
import { getSecret } from "@/services/secrets/vault";
import { SOCIAL_LIMITS } from "@zavi/shared";
import {
  LINKEDIN_SOCIAL_AUTHOR_URN_KEY,
  LINKEDIN_SOCIAL_SLUG,
  LINKEDIN_SOCIAL_TOKEN_KEY,
} from "./constants";

const UGC_POSTS_URL = "https://api.linkedin.com/v2/ugcPosts";
const REGISTER_UPLOAD_URL =
  "https://api.linkedin.com/v2/assets?action=registerUpload";

export type LinkedInPublishResult = {
  ok: boolean;
  status: number;
  raw: Record<string, unknown>;
};

function invalidText(text: string): LinkedInPublishResult | null {
  if (text.length >= 1 && text.length <= SOCIAL_LIMITS.linkedin.text) return null;
  return { ok: false, status: 400, raw: { error: `LinkedIn post text must contain 1–${SOCIAL_LIMITS.linkedin.text} characters. Edit the post before publishing.` } };
}

async function creds(tenantId: string): Promise<{ token: string; author: string }> {
  const [token, author] = await Promise.all([
    getSecret(tenantId, LINKEDIN_SOCIAL_TOKEN_KEY),
    getSecret(tenantId, LINKEDIN_SOCIAL_AUTHOR_URN_KEY),
  ]);
  if (!token || !author) {
    throw new Error("linkedin_social not connected");
  }
  return { token, author };
}

function linkedinHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-Restli-Protocol-Version": "2.0.0",
    "Content-Type": "application/json",
  };
}

async function registerImageUpload(
  token: string,
  author: string,
  recipe = "urn:li:digitalmediaRecipe:feedshare-image",
): Promise<{ ok: true; uploadUrl: string; asset: string } | LinkedInPublishResult> {
  const resp = await fetch(REGISTER_UPLOAD_URL, {
    method: "POST",
    headers: linkedinHeaders(token),
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: [recipe],
        owner: author,
        serviceRelationships: [
          {
            relationshipType: "OWNER",
            identifier: "urn:li:userGeneratedContent",
          },
        ],
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await resp.json().catch(() => ({}))) as {
    value?: {
      uploadMechanism?: {
        "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"?: {
          uploadUrl?: string;
        };
      };
      asset?: string;
    };
  };
  if (!resp.ok) {
    return { ok: false, status: resp.status, raw: { error: `linkedin registerUpload ${resp.status}`, ...(json as Record<string, unknown>) } };
  }
  const uploadUrl =
    json.value?.uploadMechanism?.[
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
    ]?.uploadUrl ?? "";
  const asset = json.value?.asset ?? "";
  if (!uploadUrl || !asset) {
    return { ok: false, status: 502, raw: { error: "linkedin registerUpload missing uploadUrl or asset" } };
  }
  return { ok: true, uploadUrl, asset };
}

async function uploadImageBinary(uploadUrl: string, token: string, bytes: Buffer): Promise<LinkedInPublishResult | null> {
  const resp = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
    },
    body: bytes,
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { ok: false, status: resp.status, raw: { error: `linkedin media upload ${resp.status}`, body: text.slice(0, 200) } };
  }
  return null;
}

async function createUgcPost(
  token: string,
  author: string,
  text: string,
  assetUrn?: string,
  category: "IMAGE" | "VIDEO" = "IMAGE",
): Promise<LinkedInPublishResult> {
  const shareContent: Record<string, unknown> = {
    shareCommentary: { text },
    shareMediaCategory: assetUrn ? category : "NONE",
  };
  if (assetUrn) {
    shareContent.media = [{ status: "READY", media: assetUrn }];
  }

  const resp = await fetch(UGC_POSTS_URL, {
    method: "POST",
    headers: linkedinHeaders(token),
    body: JSON.stringify({
      author,
      lifecycleState: "PUBLISHED",
      specificContent: { "com.linkedin.ugc.ShareContent": shareContent },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const raw: Record<string, unknown> = {};
  const postId = resp.headers.get("x-restli-id") ?? "";
  if (postId) raw.id = postId;
  if (!resp.ok) {
    try {
      Object.assign(raw, (await resp.json()) as Record<string, unknown>);
    } catch {
      raw.body = await resp.text();
    }
    return { ok: false, status: resp.status, raw };
  }
  return { ok: true, status: resp.status, raw };
}

export async function publishLinkedInText(
  tenantId: string,
  text: string,
): Promise<LinkedInPublishResult> {
  const refusal = invalidText(text);
  if (refusal) return refusal;
  const { token, author } = await creds(tenantId);
  return createUgcPost(token, author, text);
}

export async function publishLinkedInImage(
  tenantId: string,
  text: string,
  imageUrl: string,
): Promise<LinkedInPublishResult> {
  const refusal = invalidText(text);
  if (refusal) return refusal;
  const { token, author } = await creds(tenantId);
  const imgResp = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
  if (!imgResp.ok) {
    return {
      ok: false,
      status: 400,
      raw: { error: `image fetch ${imgResp.status}` },
    };
  }
  const bytes = Buffer.from(await imgResp.arrayBuffer());
  const reg = await registerImageUpload(token, author);
  if (!("uploadUrl" in reg)) return reg;
  const failed = await uploadImageBinary(reg.uploadUrl, token, bytes);
  if (failed) return failed;
  return createUgcPost(token, author, text, reg.asset);
}

export async function publishLinkedInVideo(
  tenantId: string,
  text: string,
  videoUrl: string,
): Promise<LinkedInPublishResult> {
  const refusal = invalidText(text);
  if (refusal) return refusal;
  const { token, author } = await creds(tenantId);
  const videoResp = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
  if (!videoResp.ok) {
    return { ok: false, status: 400, raw: { error: `video fetch ${videoResp.status}` } };
  }
  const bytes = Buffer.from(await videoResp.arrayBuffer());
  const reg = await registerImageUpload(token, author, "urn:li:digitalmediaRecipe:feedshare-video");
  if (!("uploadUrl" in reg)) return reg;
  const failed = await uploadImageBinary(reg.uploadUrl, token, bytes);
  if (failed) return failed;
  return createUgcPost(token, author, text, reg.asset, "VIDEO");
}

export async function isLinkedInSocialConnected(tenantId: string): Promise<boolean> {
  const token = await getSecret(tenantId, LINKEDIN_SOCIAL_TOKEN_KEY);
  const author = await getSecret(tenantId, LINKEDIN_SOCIAL_AUTHOR_URN_KEY);
  return Boolean(token && author);
}
