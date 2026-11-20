import type { AgentContext } from "@/services/agents/types";
import { healChatRunStamp } from "./direct-run";
import { labChannelSlug } from "@/services/agents/variants-lab/lab-channel-slug";
import { loadChannelHistory, switchedChannelForRun } from "./channel-actions";
import { loadLiveAdsForRun, type LiveAds } from "./live-ads";

export async function loadChannelHistoryForRun(
  ctx: Pick<AgentContext, "tenant_id" | "runId" | "variants_lab" | "draft_mode">,
  payload?: unknown,
): Promise<string[] | null> {
  try {
    const slug = (await switchedChannelForRun(ctx.tenant_id, ctx.runId)) ?? labChannelSlug(ctx, payload);
    if (!slug) return null;
    return await loadChannelHistory(ctx.tenant_id, slug, ctx.runId);
  } catch (err) {
    console.warn(
      `[generic-dispatcher] channel_history unavailable for run=${ctx.runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

export async function loadChannelContextForRun(
  ctx: Pick<AgentContext, "tenant_id" | "runId" | "trigger" | "variants_lab" | "draft_mode">,
  payload: unknown,
): Promise<{ history: string[] | null; liveAds: LiveAds | null; historyUnavailable?: boolean }> {
  let stamped: string | null = null;
  let historyUnavailable = false;
  if (ctx.trigger !== "channel_recipe") {
    try {
      if (ctx.trigger === "chat") {
        const healed = await healChatRunStamp(ctx.tenant_id, ctx.runId);
        historyUnavailable = healed === "failed" || healed === "unreadable";
        stamped = healed === "failed" || healed === "unreadable" ? null : healed;
      } else {
        stamped = await switchedChannelForRun(ctx.tenant_id, ctx.runId);
      }
    } catch {
      stamped = null;
      historyUnavailable = true;
    }
    if (!stamped) return { history: null, liveAds: null, ...(historyUnavailable ? { historyUnavailable: true } : {}) };
  }
  const hinted = stamped
    ? { ...(payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}), channel_slug: stamped }
    : payload;
  const [history, liveAds] = await Promise.all([
    stamped
      ? loadChannelHistory(ctx.tenant_id, stamped, ctx.runId).catch(() => null)
      : loadChannelHistoryForRun(ctx, payload),
    isDefinitionOnlyChat(ctx.trigger, payload)
      ? Promise.resolve(null)
      : loadLiveAdsForRun(ctx, hinted, stamped ? { stampedSlug: async () => stamped } : {}),
  ]);
  return { history, liveAds, ...((stamped || ctx.trigger === "channel_recipe") && history === null ? { historyUnavailable: true } : {}) };
}

export function isDefinitionOnlyChat(trigger: string, payload: unknown): boolean {
  if (trigger !== "chat" || !payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  const text = typeof p.current_user_text_raw === "string" ? p.current_user_text_raw : p.current_message;
  if (typeof text !== "string") return false;
  return /^(?:what (?:does|is|are) (?:ctr|cpc|cpm|cpa|roas|click.through rate|cost per click|return on ad spend)(?: mean| stand for)?(?: in advertising)?[?.!]?|define (?:ctr|cpc|cpm|cpa|roas)[?.!]?)$/i.test(text.trim());
}
