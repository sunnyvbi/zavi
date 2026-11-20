import { announceSocialPosted } from "./socialPostEvents";
import { watchSocialPost, type PostOutcome } from "./socialPostWatch";

export type PendingSocialPost = {
  decisionId: string;
  platform: string;
  attempts: number;
  expiresAt: number;
};

export type SocialPostNotice = {
  type: "success" | "error" | "info";
  title: string;
  description: string;
  timeout: number;
};

const PENDING_PREFIX = "zavi:pending-social-posts:";
const active = new Map<string, Promise<PostOutcome>>();
export const SOCIAL_POST_RESUME_ATTEMPTS = 3;
export const SOCIAL_POST_PENDING_TTL_MS = 24 * 60 * 60_000;

export function socialPostFollowActive(tenantId: string | null | undefined, decisionId: string): boolean {
  return active.has(`${tenantId ?? "_"}:${decisionId}`);
}

function storageKey(tenantId: string): string {
  return `${PENDING_PREFIX}${tenantId}`;
}

export function pendingSocialPosts(tenantId: string | null | undefined): PendingSocialPost[] {
  if (!tenantId) return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(tenantId)) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    const pending = parsed.filter(
      (item): item is PendingSocialPost =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as PendingSocialPost).decisionId === "string" &&
        typeof (item as PendingSocialPost).platform === "string" &&
        Number.isInteger((item as PendingSocialPost).attempts) &&
        (item as PendingSocialPost).attempts >= 0 &&
        (item as PendingSocialPost).attempts < SOCIAL_POST_RESUME_ATTEMPTS &&
        typeof (item as PendingSocialPost).expiresAt === "number" &&
        (item as PendingSocialPost).expiresAt > now,
    );
    if (pending.length !== parsed.length) writePending(tenantId, pending);
    return pending;
  } catch {
    return [];
  }
}

function writePending(tenantId: string | null | undefined, posts: PendingSocialPost[]): void {
  if (!tenantId) return;
  try {
    if (posts.length === 0) window.localStorage.removeItem(storageKey(tenantId));
    else window.localStorage.setItem(storageKey(tenantId), JSON.stringify(posts));
  } catch {
    return;
  }
}

export function rememberSocialPost(
  tenantId: string | null | undefined,
  post: Pick<PendingSocialPost, "decisionId" | "platform">,
): void {
  if (!tenantId) return;
  const current = pendingSocialPosts(tenantId);
  if (!current.some((item) => item.decisionId === post.decisionId)) {
    writePending(tenantId, [
      ...current,
      { ...post, attempts: 0, expiresAt: Date.now() + SOCIAL_POST_PENDING_TTL_MS },
    ]);
  }
}

export function forgetSocialPost(tenantId: string | null | undefined, decisionId: string): void {
  if (!tenantId) return;
  writePending(tenantId, pendingSocialPosts(tenantId).filter((item) => item.decisionId !== decisionId));
}

function recordSlowAttempt(tenantId: string | null | undefined, decisionId: string): void {
  if (!tenantId) return;
  const next = pendingSocialPosts(tenantId)
    .map((item) =>
      item.decisionId === decisionId ? { ...item, attempts: item.attempts + 1 } : item,
    )
    .filter((item) => item.attempts < SOCIAL_POST_RESUME_ATTEMPTS);
  writePending(tenantId, next);
}

export function socialPostNotice(out: PostOutcome, platform: string): SocialPostNotice {
  if (out.state === "partial") {
    return { type: "info", title: `${platform} thread partly posted`, description: out.message, timeout: 12_000 };
  }
  if (out.state === "posted") {
    return {
      type: "success",
      title: `Posted to ${platform}`,
      description: platform === "Pinterest" ? "Your pin is live on your board." : "Your post is live.",
      timeout: 6000,
    };
  }
  if (out.state === "failed") {
    return { type: "error", title: `Couldn't post to ${platform}`, description: out.message, timeout: 12_000 };
  }
  if (out.state === "approval_uncertain") {
    return {
      type: "info",
      title: "Could not confirm approval",
      description: `Review the original ${platform === "Pinterest" ? "pin" : "post"}. If it still asks for approval, retrying that same approval is safe.`,
      timeout: 10_000,
    };
  }
  if (out.state === "scheduled") {
    return {
      type: "success",
      title: `Scheduled for ${platform}`,
      description: `Publication is scheduled for ${new Date(out.scheduledAt).toLocaleString()}.`,
      timeout: 8000,
    };
  }
  if (out.state === "uncertain") {
    return { type: "info", title: `${platform} outcome uncertain`, description: out.message, timeout: 12_000 };
  }
  return {
    type: "info",
    title: `Still posting to ${platform}`,
    description: `${platform} has not answered yet. Zavi will check again when this workspace is opened or focused.`,
    timeout: 10_000,
  };
}

export function followSocialPost(
  decisionId: string,
  platform: string,
  tenantId: string | null | undefined,
  watch: (id: string) => Promise<PostOutcome> = (id) => watchSocialPost(id, undefined, { platform }),
): Promise<PostOutcome> {
  const key = `${tenantId ?? "_"}:${decisionId}`;
  const running = active.get(key);
  if (running) return running;

  rememberSocialPost(tenantId, { decisionId, platform });
  const task = watch(decisionId)
    .then((out) => {
      if (out.state === "slow") recordSlowAttempt(tenantId, decisionId);
      else forgetSocialPost(tenantId, decisionId);
      if (out.state === "posted" || out.state === "partial") announceSocialPosted();
      return out;
    })
    .finally(() => {
      if (active.get(key) === task) active.delete(key);
    });
  active.set(key, task);
  return task;
}
