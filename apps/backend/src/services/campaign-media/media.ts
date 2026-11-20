export type CampaignThumbnails = Record<string, string[]>;
export const emptyThumbnails = (ids: readonly string[]): CampaignThumbnails => Object.fromEntries(ids.map((id) => [id, []]));
export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const stringId = (value: unknown): string | null => typeof value === "string" ? value : typeof value === "number" ? String(value) : null;

export function mediaUrls(value: unknown): string[] {
  const result = new Set<string>();
  const direct = new Set(["thumbnail_url", "thumbnailUrl", "image_url", "imageUrl", "video_cover_url", "cover_url", "downloadUrl", "media_url_https", "media_url", "preview_image_url", "thumbnail"]);
  const containers = new Set(["image", "images", "thumbnail", "thumbnails", "picture", "preview", "source", "media", "image_value"]);
  const visit = (node: unknown, context: string, depth: number) => {
    if (depth > 8 || result.size >= 6) return;
    if (Array.isArray(node)) { for (const child of node.slice(0, 50)) visit(child, context, depth + 1); return; }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node).slice(0, 100)) {
      if (typeof child === "string" && (direct.has(key) || key === "url" && containers.has(context) || key === "picture")) {
        try {
          const url = new URL(child.replace(/&amp;/g, "&"));
          if (url.protocol === "https:" && !url.username && !url.password) result.add(url.href);
        } catch {}
      } else if (typeof child === "object" && child) visit(child, key, depth + 1);
    }
  };
  visit(value, "", 0);
  return [...result].slice(0, 6);
}

export async function inGroups<T, R>(items: readonly T[], read: (item: T) => Promise<R>, size = 4): Promise<R[]> {
  const out: R[] = [];
  const failures: unknown[] = [];
  for (let i = 0; i < items.length; i += size) {
    const results = await Promise.allSettled(items.slice(i, i + size).map(read));
    for (const result of results) {
      if (result.status === "fulfilled") out.push(result.value);
      else failures.push(result.reason);
    }
  }
  if (items.length > 0 && !out.length && failures.length) throw failures[0];
  return out;
}

export function addMedia(result: CampaignThumbnails, campaignId: string, value: unknown): void {
  const current = result[campaignId];
  if (current) result[campaignId] = [...new Set([...current, ...mediaUrls(value)])].slice(0, 6);
}
