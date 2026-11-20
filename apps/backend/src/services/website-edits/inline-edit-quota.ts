
import { asTenantId, tenantRpc } from "@/services/tenant-client";

export const INLINE_EDIT_PER_SITE_PER_MIN = 10;
export const INLINE_EDIT_PER_TENANT_PER_DAY = 200;

export type InlineEditTake = "ok" | "site_rate_limited" | "daily_cap" | "unavailable";

export async function takeInlineEditCall(tenant_id: string, app_id: string): Promise<InlineEditTake> {
  try {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "take_inline_edit_call", {
      p_app_id: app_id,
      p_per_site_per_min: INLINE_EDIT_PER_SITE_PER_MIN,
      p_per_tenant_per_day: INLINE_EDIT_PER_TENANT_PER_DAY,
    });
    if (error) throw new Error(error.message);
    return data === "ok" || data === "site_rate_limited" || data === "daily_cap" ? data : "unavailable";
  } catch (e) {
    console.warn(JSON.stringify({ evt: "inline_edit_quota_unavailable", tenant_id, error: String((e as Error)?.message ?? e).slice(0, 200) }));
    return "unavailable";
  }
}

export function quotaRefusal(state: Exclude<InlineEditTake, "ok">): { status: number; body: unknown } {
  switch (state) {
    case "site_rate_limited":
      return {
        status: 429,
        body: { error: { code: "rate_limited", chat: "That's a lot of quick edits in a minute. Wait a moment, then try again." } },
      };
    case "daily_cap":
      return {
        status: 429,
        body: {
          error: {
            code: "daily_limit",
            chat: "You've used today's quick AI edits. Ask for the change in the Build chat instead, or try again tomorrow.",
          },
        },
      };
    case "unavailable":
      return { status: 503, body: { error: { code: "edit_unavailable", chat: "I couldn't work that out just now - try again in a moment." } } };
  }
}
