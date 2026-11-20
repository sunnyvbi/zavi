export type XThreadOutcome = {
  publishedParts: number;
  totalParts: number | null;
  message: string;
};

export function xThreadOutcome(response: unknown, expectedTotal?: number): XThreadOutcome | null {
  if (!response || typeof response !== "object") return null;
  const raw = response as Record<string, unknown>;
  if (!raw.thread_error || typeof raw.thread_error !== "object" || typeof raw.id !== "string" || !raw.id) return null;
  const publishedParts = 1 + (Array.isArray(raw.thread_ids) ? raw.thread_ids.filter(id => typeof id === "string" && id.length > 0).length : 0);
  const totalParts = Number.isInteger(expectedTotal) && Number(expectedTotal) > publishedParts ? Number(expectedTotal) : null;
  const status = (raw.thread_error as Record<string, unknown>).status;
  const uncertain = status === 0 || (typeof status === "number" && (status >= 500 || (status >= 200 && status < 300)));
  const count = `${publishedParts}${totalParts ? ` of ${totalParts}` : ""}`;
  return {
    publishedParts,
    totalParts,
    message: `${uncertain ? `${count} posts in the thread are confirmed published. Zavi could not confirm whether the next post reached X.` : `Only ${count} posts in the thread published.`} Check the thread on X before posting the rest; do not repost the whole thread.`,
  };
}
