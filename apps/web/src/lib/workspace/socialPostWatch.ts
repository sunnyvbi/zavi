import { xThreadOutcome } from "@zavi/shared";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { createBrowserSupabase } from "@/lib/supabase";

export type AttemptReason = { code: string | null; message: string | null; response?: unknown };

export type PostRow = { id: string; status: string; last_error: string | null; external_url: string | null; scheduled_at: string | null; thread?: unknown };
export type DecisionRow = { status: string; dispatch_error: string | null };

export type PostOutcome =
  | { state: "posted"; url: string | null }
  | { state: "partial"; url: string | null; publishedParts: number; totalParts: number | null; message: string }
  | { state: "failed"; message: string }
  | { state: "approval_uncertain" }
  | { state: "scheduled"; scheduledAt: string }
  | { state: "uncertain"; message: string }
  | { state: "slow" };

export type WatchDeps = {
  readPost: (decisionId: string) => Promise<PostRow | null>;
  readDecision: (decisionId: string) => Promise<DecisionRow | null>;
  readReason: (postId: string) => Promise<AttemptReason | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

function failureCopy(platform: string): Record<string, string> {
  const pin = platform === "Pinterest";
  return {
    disconnected: `${platform} is no longer connected. Reconnect it, then post again.`,
    unauthorized_destination: `The connected account can no longer post to that ${pin ? "board" : "account"}.`,
    vendor_rejected: `${platform} did not accept it.`,
    transient_exhausted: platform === "Instagram"
      ? "Zavi could not confirm whether the post reached Instagram. Check Instagram before posting again."
      : `${platform} kept timing out, so Zavi could not confirm whether it posted. Check ${platform} before posting again.`,
    channel_disabled: `${platform} is switched off in Zavi.`,
    snapshot_changed: `The ${pin ? "pin" : "post"} changed after it was approved. Create it again.`,
    reconnect_required: pin ? "Reconnect Pinterest to post this pin." : `Reconnect ${platform} to publish this post.`,
  };
}

const ZAVI_REFUSALS = new Set([
  "media_link_not_public",
  "account_check_failed",
  "publish_refused_test_marker",
  "publish_refused_blanks",
  "pinterest_not_connected",
  "pinterest_no_boards",
  "pinterest_board_missing",
  "pinterest_board_secret",
  "pinterest_media_invalid",
  "pinterest_link_unreachable",
  "pinterest_link_nopin",
  "pinterest_identity_mismatch",
]);

export function refusalMessage(r: AttemptReason | null): string | null {
  if (!r?.code || !ZAVI_REFUSALS.has(r.code)) return null;
  return r.message?.trim() || "Zavi stopped it before it reached the platform, so nothing was posted.";
}

export function failureMessage(code: string | null, reason: string | null, platform = "Pinterest"): string {
  const base = (code && failureCopy(platform)[code]) || "Something went wrong while posting.";
  if (reason && /not a signed https URL/i.test(reason)) return `Zavi couldn't make a public link to the image, so nothing was sent to ${platform}.`;
  return reason && code === "vendor_rejected" ? `${base} ${reason.trim().replace(/\.+$/, "")}.` : base;
}

const DONE = new Set(["published", "failed", "cancelled"]);

export function dispatchFailureMessage(error: string | null, platform = "Pinterest"): string {
  const message = error?.trim() ?? "";
  if (/publishing isn't enabled/i.test(message)) return `Social publishing isn't enabled for this workspace yet. Nothing was sent to ${platform}.`;
  if (/not connected|no connected|reconnect/i.test(message)) return failureCopy(platform).disconnected;
  if (/plan|upgrade/i.test(message)) return `${platform} publishing is not available on this workspace's current plan. Nothing was sent.`;
  return `Zavi could not start this ${platform} post. Nothing was sent to ${platform}.`;
}

export function attemptReason(raw: unknown): AttemptReason | null {
  if (!raw || typeof raw !== "object") return null;
  const response = raw as { error?: unknown; code?: unknown; message?: unknown };
  const text = typeof response.message === "string" ? response.message : typeof response.error === "string" ? response.error : null;
  return { code: typeof response.code === "string" ? response.code : null, message: text, response };
}

export function failedPostMessage(lastError: string | null, reason: AttemptReason | null, platform = "Pinterest"): string {
  return refusalMessage(reason) ?? failureMessage(lastError, reason?.message ?? null, platform);
}

export async function watchSocialPost(
  decisionId: string,
  deps: WatchDeps = realWatchDeps,
  { intervalMs = 2000, timeoutMs = 10 * 60_000, platform = "Pinterest" }: { intervalMs?: number; timeoutMs?: number; platform?: string } = {},
): Promise<PostOutcome> {
  const start = deps.now();
  for (;;) {
    let postReadSucceeded = false;
    const row = await deps.readPost(decisionId).then((value) => {
      postReadSucceeded = true;
      return value;
    }).catch(() => null);
    if (row && DONE.has(row.status)) {
      if (row.status === "published") {
        if (platform === "X") {
          const attempt = await deps.readReason(row.id).catch(() => null);
          const total = Array.isArray(row.thread) && row.thread.length ? row.thread.length + 1 : undefined;
          const partial = xThreadOutcome(attempt?.response, total);
          if (partial) return { state: "partial", url: row.external_url, ...partial };
          if (total && !attempt?.response) return {
            state: "uncertain",
            message: "The first post is published, but Zavi could not verify the rest of the thread. Check X before posting again; do not repost the whole thread.",
          };
        }
        return { state: "posted", url: row.external_url };
      }
      const reason = row.status === "failed" ? await deps.readReason(row.id).catch(() => null) : null;
      if (row.status === "cancelled") return { state: "failed", message: "The post was cancelled before it went out." };
      const refused = refusalMessage(reason);
      if (!refused && row.last_error === "transient_exhausted") {
        return { state: "uncertain", message: failureMessage(row.last_error, null, platform) };
      }
      return { state: "failed", message: failedPostMessage(row.last_error, reason, platform) };
    }
    if ((postReadSucceeded && !row) || row?.status === "approved" || row?.status === "scheduled") {
      const decision = await deps.readDecision(decisionId).catch(() => null);
      if (decision?.status === "dispatch_failed") {
        if (row) {
          return {
            state: "uncertain",
            message: `Zavi could not confirm whether ${platform} publishing was queued. Do not create another ${platform === "Pinterest" ? "pin" : "post"}; check ${platform} before trying again.`,
          };
        }
        let confirmedRead = false;
        const confirmedRow = await deps.readPost(decisionId).then((value) => {
          confirmedRead = true;
          return value;
        }).catch(() => null);
        if (!confirmedRead) {
          if (deps.now() - start >= timeoutMs) return { state: "slow" };
          await deps.sleep(intervalMs);
          continue;
        }
        if (confirmedRow) {
          return {
            state: "uncertain",
            message: `Zavi could not confirm whether ${platform} publishing was queued. Do not create another ${platform === "Pinterest" ? "pin" : "post"}; check ${platform} before trying again.`,
          };
        }
        return { state: "failed", message: dispatchFailureMessage(decision.dispatch_error, platform) };
      }
      if (!row && decision?.status === "proposed") return { state: "approval_uncertain" };
      if (row?.status === "scheduled" && row.scheduled_at && decision?.status === "acted") {
        const scheduledAt = Date.parse(row.scheduled_at);
        if (!Number.isNaN(scheduledAt) && scheduledAt > deps.now()) {
          return { state: "scheduled", scheduledAt: row.scheduled_at };
        }
      }
    }
    if (deps.now() - start >= timeoutMs) return { state: "slow" };
    await deps.sleep(intervalMs);
  }
}

export const realWatchDeps: WatchDeps = {
  async readPost(decisionId) {
    const sb = createBrowserSupabase();
    const tid = await getActiveTenantId(sb);
    if (!tid) return null;
    const { data, error } = await sb
      .from("social_posts")
      .select("id, status, last_error, external_url, scheduled_at, thread:approved_payload_snapshot->payload->thread")
      .eq("tenant_id", tid)
      .eq("decision_id", decisionId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    return ((data ?? [])[0] as PostRow | undefined) ?? null;
  },
  async readDecision(decisionId) {
    const sb = createBrowserSupabase();
    const tid = await getActiveTenantId(sb);
    if (!tid) return null;
    const { data } = await sb
      .from("decisions")
      .select("status, dispatch_error")
      .eq("tenant_id", tid)
      .eq("id", decisionId)
      .maybeSingle();
    return (data as DecisionRow | null) ?? null;
  },
  async readReason(postId) {
    const sb = createBrowserSupabase();
    const tid = await getActiveTenantId(sb);
    if (!tid) return null;
    const { data } = await sb
      .from("social_publish_attempts")
      .select("response, social_posts!inner(tenant_id)")
      .eq("social_posts.tenant_id", tid)
      .eq("post_id", postId)
      .order("created_at", { ascending: false })
      .limit(1);
    return attemptReason(((data ?? [])[0] as { response?: unknown } | undefined)?.response);
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};
