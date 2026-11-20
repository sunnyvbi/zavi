
import { actionsStoreFor } from "@zavi/shared";

export function labChannelSlug(
  ctx: { variants_lab?: boolean; draft_mode?: boolean },
  payload: unknown,
): string | null {
  if (ctx.variants_lab !== true || ctx.draft_mode !== true) return null;
  const slug = payload && typeof payload === "object" ? (payload as { channel_slug?: unknown }).channel_slug : null;
  if (typeof slug !== "string" || !/^[a-z0-9_]{1,40}$/.test(slug)) return null;
  return actionsStoreFor(slug) === "channel_actions" ? slug : null;
}
