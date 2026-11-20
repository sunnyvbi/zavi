
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { fbGet, metaAdsCreds } from "./_client";

const EDGES = {
  pixels: { edge: "adspixels", fields: "id,name,last_fired_time,is_unavailable,creation_time" },
  custom_conversions: { edge: "customconversions", fields: "id,name,custom_event_type,rule,last_fired_time,is_archived,pixel{id}" },
} as const;

const input = z.object({ kind: z.enum(["pixels", "custom_conversions"]) });

export const metaListMeasurementTool: ToolSpec = {
  name: "meta_ads_list_measurement",
  effect: "read",
  description:
    "List the ad account's pixels (with when each last fired) or its custom conversions (event, URL rule, last fired). Use before proposing a custom conversion or judging whether conversions are tracked.",
  input_schema: input,
  async execute(ctx, raw) {
    const a = input.parse(raw);
    const creds = await metaAdsCreds(ctx.tenant_id);
    const e = EDGES[a.kind];
    const r = (await fbGet(ctx.tenant_id, `${creds.ad_account_id}/${e.edge}`, { fields: e.fields, limit: 100 })) as {
      data?: Array<Record<string, unknown>>;
      paging?: { next?: string };
    };
    return { kind: a.kind, items: r.data ?? [], truncated: !!r.paging?.next };
  },
};
