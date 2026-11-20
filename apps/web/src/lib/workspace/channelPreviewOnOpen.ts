import { apiFetch } from "@/lib/api";

export function startChannelPreviewOnOpen(slug: string): void {
  void apiFetch(`/api/channels/${encodeURIComponent(slug)}/preview-on-open`, { method: "POST" }).catch(() => undefined);
}
