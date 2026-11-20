
import { asTenantId, tenantClient } from "@/services/tenant-client";

const TABLE = "creator_publications";

export const PUBLISH_PLATFORMS = ["tiktok", "instagram", "youtube", "facebook", "x", "linkedin", "pinterest", "other"] as const;
export type PublishPlatform = (typeof PUBLISH_PLATFORMS)[number];
export type Verification = "verified" | "pending" | "manual" | "failed";

export type CreatorPublication = {
  id: string;
  order_id: string;
  publisher: "business" | "creator";
  platform: PublishPlatform;
  account: string | null;
  post_url: string | null;
  status: "scheduled" | "published";
  scheduled_for: string | null;
  published_at: string | null;
  verification: Verification;
  verification_note: string | null;
  verified_at: string | null;
  created_at: string;
};

const COLUMNS =
  "id, order_id, publisher, platform, account, post_url, status, scheduled_for, published_at, verification, verification_note, verified_at, created_at";

const HOSTS: Record<PublishPlatform, string[] | null> = {
  tiktok: ["tiktok.com"],
  instagram: ["instagram.com"],
  youtube: ["youtube.com", "youtu.be"],
  facebook: ["facebook.com", "fb.watch"],
  x: ["x.com", "twitter.com"],
  linkedin: ["linkedin.com"],
  pinterest: ["pinterest.com", "pin.it"],
  other: null,
};

export function postUrlFor(platform: PublishPlatform, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const hosts = HOSTS[platform];
  if (!hosts) return url.toString();
  const host = url.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`)) ? url.toString() : null;
}

export function publisherFor(packageSnapshot: Record<string, unknown> | null): "business" | "creator" {
  return packageSnapshot?.kind === "audience_post" ? "creator" : "business";
}

const OEMBED: Partial<Record<PublishPlatform, (url: string) => string>> = {
  youtube: (u) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u)}`,
  tiktok: (u) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(u)}`,
};

const handle = (s: string) => s.trim().replace(/^@/, "").toLowerCase();

export type VerifyResult = { verification: Verification; note: string | null };

export async function verifyPost(
  platform: PublishPlatform,
  post_url: string,
  account: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const endpoint = OEMBED[platform];
  if (!endpoint) return { verification: "manual", note: "This platform has no public check. Open the link to confirm the post." };
  let res: Response;
  try {
    res = await fetchImpl(endpoint(post_url), { signal: AbortSignal.timeout(8000) });
  } catch {
    return { verification: "pending", note: "Could not reach the platform to check. Try again later." };
  }
  if (res.status === 404 || res.status === 400) {
    return { verification: "failed", note: "The platform did not find a public post at this link." };
  }
  if (res.status === 401 || res.status === 403) {
    return { verification: "manual", note: "The platform would not let Zavi check this post. Open the link to confirm." };
  }
  if (!res.ok) return { verification: "pending", note: "The platform did not answer the check. Try again later." };
  const body = (await res.json().catch(() => null)) as { author_name?: string; author_url?: string } | null;
  const want = account ? handle(account) : "";
  if (!want) return { verification: "manual", note: "The post exists. No account was entered, so open the link to confirm who posted it." };
  let seg = "";
  try {
    seg = decodeURIComponent(new URL(body?.author_url ?? "").pathname.split("/").filter(Boolean).pop() ?? "");
  } catch {
    seg = "";
  }
  if (!seg.startsWith("@")) {
    return { verification: "manual", note: "The post exists, but the platform gave no handle to match. Open the link to confirm the account." };
  }
  if (handle(seg) === want) {
    return { verification: "verified", note: null };
  }
  return {
    verification: "failed",
    note: `The post exists, but it is by ${body?.author_name ?? "another account"}, not ${account}.`,
  };
}

export async function listPublications(tenant_id: string, order_id: string): Promise<CreatorPublication[]> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from(TABLE)
    .select(COLUMNS)
    .eq("order_id", order_id)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`creator_publications read failed: ${error.message}`);
  return (data ?? []) as unknown as CreatorPublication[];
}

export async function insertPublication(
  tenant_id: string,
  row: Omit<CreatorPublication, "id" | "created_at"> & { created_by: string },
): Promise<CreatorPublication> {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from(TABLE).insert(row).select(COLUMNS).maybeSingle();
  if (error || !data) throw new Error(`creator_publications insert failed: ${error?.message ?? "no row"}`);
  return data as unknown as CreatorPublication;
}

export async function updateVerification(
  tenant_id: string,
  id: string,
  v: VerifyResult,
  now: Date = new Date(),
): Promise<CreatorPublication | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from(TABLE)
    .update({
      verification: v.verification,
      verification_note: v.note,
      verified_at: v.verification === "verified" ? now.toISOString() : null,
    })
    .eq("id", id)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`creator_publications update failed: ${error.message}`);
  return (data as unknown as CreatorPublication | null) ?? null;
}

export async function loadPublication(tenant_id: string, id: string): Promise<CreatorPublication | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from(TABLE).select(COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(`creator_publications read failed: ${error.message}`);
  return (data as unknown as CreatorPublication | null) ?? null;
}
