import { campaignFetch } from "./api";

type Entry = { promise: Promise<unknown>; value?: { review: unknown; at: number } };

export const ADS_CONNECTION_CHANGED_EVENT = "zavi:ads-connection-changed";
export const CAMPAIGN_REVIEW_TTL_MS = 5 * 60 * 1000;

const entries = new Map<string, Entry>();
const holders = new Map<string, number>();

const keyOf = (path: string, revision?: string) => `${path}\n${revision ?? ""}`;

const incomplete = (review: unknown) => !!(review as { suggested?: { location_search_failed?: unknown } } | null)?.suggested?.location_search_failed;

const expired = (entry: Entry) => !!entry.value && Date.now() - entry.value.at >= CAMPAIGN_REVIEW_TTL_MS;

function live(key: string): Entry | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (!expired(entry)) return entry;
  entries.delete(key);
  return undefined;
}

function start(key: string, path: string): Entry {
  const entry: Entry = { promise: campaignFetch(path) };
  entries.set(key, entry);
  const drop = () => { if (entries.get(key) === entry) entries.delete(key); };
  entry.promise.then((review) => { if (incomplete(review)) drop(); else entry.value = { review, at: Date.now() }; }, drop);
  return entry;
}

export function holdCampaignReview(path: string, revision?: string): () => void {
  const key = keyOf(path, revision);
  entries.forEach((entry, k) => { if (expired(entry)) entries.delete(k); });
  holders.set(key, (holders.get(key) ?? 0) + 1);
  if (!live(key)) start(key, path);
  return () => {
    const left = Math.max(0, (holders.get(key) ?? 0) - 1);
    if (left) holders.set(key, left);
    else holders.delete(key);
  };
}

export function cachedCampaignReview<T>(path: string, revision?: string): T | undefined {
  const value = live(keyOf(path, revision))?.value;
  return value ? value.review as T : undefined;
}

export function loadCampaignReview<T>(path: string, revision?: string): Promise<T> {
  const key = keyOf(path, revision);
  const entry = live(key);
  if (entry) return entry.promise as Promise<T>;
  return (holders.get(key) ? start(key, path).promise : campaignFetch<T>(path)) as Promise<T>;
}

export function invalidateCampaignReviews() {
  entries.clear();
}

export function forgetCampaignReview(path: string, revision?: string) {
  entries.delete(keyOf(path, revision));
}
