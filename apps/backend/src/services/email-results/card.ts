
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { EmailCardRail } from "@/services/email-cards/cards";
import type { EmailRoute } from "@/services/email-templates/render";
import { computeWinLine, winLineText, type WinLine } from "./win-line";

export type CardWinLine = { text: string; metric: WinLine["metric"]; threshold: number | null; frozen: boolean };

export type CardWinLineDeps = {
  frozen: (tenantId: string, rail: EmailCardRail, id: string) => Promise<WinLine | null>;
  gaConnected: (tenantId: string) => Promise<boolean>;
  compute: typeof computeWinLine;
};

const LIVE: CardWinLineDeps = {
  frozen: async (tenantId, rail, id) => {
    const { data, error } = await tenantClient(asTenantId(tenantId)).from("email_send_results").select("win_line").eq("rail", rail).eq("card_id", id).maybeSingle();
    if (error) throw new Error("email_send_results read failed");
    return ((data as { win_line?: WinLine } | null)?.win_line as WinLine | undefined) ?? null;
  },
  gaConnected: async (tenantId) => {
    const { googleAnalyticsCreds } = await import("@/services/tools/google-analytics/_client");
    try {
      return Boolean((await googleAnalyticsCreds(tenantId)).property_id);
    } catch {
      return false;
    }
  },
  compute: computeWinLine,
};

export async function cardWinLine(
  tenantId: string,
  rail: EmailCardRail,
  id: string,
  cls: string,
  body: Record<string, unknown>,
  depsIn: Partial<CardWinLineDeps> = {},
): Promise<CardWinLine | null> {
  const deps = { ...LIVE, ...depsIn };
  try {
    const frozen = await deps.frozen(tenantId, rail, id);
    if (frozen && typeof frozen === "object" && "basis" in frozen) {
      return { text: winLineText(frozen), metric: frozen.metric, threshold: frozen.threshold, frozen: true };
    }
    if (!Array.isArray(body.variants)) return null;
    const route = (cls === "bulk_outbound.send" ? "zavi_list" : body.tool) as EmailRoute;
    const listId = cls === "bulk_outbound.send" ? body.list_id : body.audience_id;
    const slug = (body.template_snapshot as { campaign_slug?: unknown } | undefined)?.campaign_slug;
    const tagged = typeof slug === "string" && slug.length > 0;
    const w = await deps.compute(tenantId, {
      route,
      listId: typeof listId === "string" ? listId : null,
      tagged,
      gaConnected: tagged ? await deps.gaConnected(tenantId) : false,
    });
    return { text: winLineText(w), metric: w.metric, threshold: w.threshold, frozen: false };
  } catch {
    return null;
  }
}
