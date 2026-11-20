import { isInternalHostUrl } from "@/lib/workspace/publicAppUrl";

export type PreviewSource = { prefix: string; url: string | null; note?: string };

export function previewSource(
  marketingUrl: string | null,
  builtinUrl: string | null,
  builtAppUrl: string | null,
  buildPreviewUrl: string | null = null,
): PreviewSource {
  if (marketingUrl) return { prefix: "Website", url: marketingUrl };
  if (builtinUrl) return { prefix: "Built app", url: builtinUrl };
  if (builtAppUrl && isInternalHostUrl(builtAppUrl)) return { prefix: "Built app", url: null, note: "not published yet" };
  if (builtAppUrl) return { prefix: "Built app", url: builtAppUrl };
  if (buildPreviewUrl) return { prefix: "Building", url: buildPreviewUrl };
  return { prefix: "Website", url: null };
}

export function previewSourceLabel(
  marketingUrl: string | null,
  builtinUrl: string | null,
  builtAppUrl: string | null,
  buildPreviewUrl: string | null = null,
): string {
  const s = previewSource(marketingUrl, builtinUrl, builtAppUrl, buildPreviewUrl);
  return s.url ? `${s.prefix}: ${s.url}` : `${s.prefix}: ${s.note ?? "not set"}`;
}
