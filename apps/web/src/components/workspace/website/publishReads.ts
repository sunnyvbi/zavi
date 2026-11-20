import { apiFetch } from "@/lib/api";
import type { BuiltinUrl, Visibility } from "./PublishPopover";

export type PublishStatus = { pending: number; published: number; last_published_at: string | null };
export type BuiltinReply = { builtin?: BuiltinUrl | null; base_domain?: string; custom_domain_attached?: boolean };
export type OverviewReply = { visibility?: Visibility };
type PublishReads = { status?: PublishStatus; builtin?: BuiltinReply; overview?: OverviewReply };

export const publishReads = new Map<string, PublishReads>();

export function publishReadsKey(editsApp: string | null, siteSession: boolean): string {
  return `${siteSession ? "site" : "app"}:${editsApp ?? ""}`;
}

export function rememberRead<K extends keyof PublishReads>(key: string, field: K, value: PublishReads[K]): void {
  publishReads.set(key, { ...(publishReads.get(key) ?? {}), [field]: value });
}

async function readJson<T>(url: string): Promise<T | null> {
  try {
    const res = await apiFetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export type PublishPrefetch = { editsApp: string | null; editsReadable: boolean; siteSession: boolean; readsBuiltin: boolean };

export async function prefetchPublishPopover(p: PublishPrefetch): Promise<void> {
  const key = publishReadsKey(p.editsApp, p.siteSession);
  await Promise.allSettled([
    p.editsReadable && p.editsApp
      ? readJson<PublishStatus>(`/api/website/publish-status?app=${encodeURIComponent(p.editsApp)}`).then((j) => j && rememberRead(key, "status", j))
      : null,
    !p.siteSession ? readJson<OverviewReply>("/api/website/overview?app=workspace").then((j) => j && rememberRead(key, "overview", j)) : null,
    !p.siteSession && p.readsBuiltin ? readJson<BuiltinReply>("/api/website/builtin-url").then((j) => j && rememberRead(key, "builtin", j)) : null,
  ]);
}

export function resetPublishReads(): void {
  publishReads.clear();
}

