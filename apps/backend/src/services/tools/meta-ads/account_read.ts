
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { fbGet, metaAdsCreds } from "./_client";
import { assertMetaScopes } from "./_scopes";

type Needs = "none" | "business" | "account" | "id";
type Resource = { needs: Needs; edge: (id: string, account: string) => string; fields?: string; scope?: string; params?: Record<string, string> };

const BIZ_ASSET = "id,name";
const PEOPLE = "id,name,role";

export const RESOURCES: Readonly<Record<string, Resource>> = {
  me: { needs: "none", edge: () => "me", fields: "id,name" },
  ad_accounts: { needs: "none", edge: () => "me/adaccounts", fields: "id,name,account_status,currency,timezone_name" },
  businesses: { needs: "none", edge: () => "me/businesses", fields: "id,name,verification_status", scope: "business_management" },
  owned_ad_accounts: { needs: "business", edge: (b) => `${b}/owned_ad_accounts`, fields: "id,name,account_status,currency", scope: "business_management" },
  client_ad_accounts: { needs: "business", edge: (b) => `${b}/client_ad_accounts`, fields: "id,name,account_status,currency", scope: "business_management" },
  pending_owned_ad_accounts: { needs: "business", edge: (b) => `${b}/pending_owned_ad_accounts`, fields: "id,name", scope: "business_management" },
  pending_client_ad_accounts: { needs: "business", edge: (b) => `${b}/pending_client_ad_accounts`, fields: "id,ad_account{id,name}", scope: "business_management" },
  owned_pages: { needs: "business", edge: (b) => `${b}/owned_pages`, fields: "id,name,category", scope: "business_management" },
  client_pages: { needs: "business", edge: (b) => `${b}/client_pages`, fields: "id,name,category", scope: "business_management" },
  pending_owned_pages: { needs: "business", edge: (b) => `${b}/pending_owned_pages`, fields: BIZ_ASSET, scope: "business_management" },
  pending_client_pages: { needs: "business", edge: (b) => `${b}/pending_client_pages`, fields: "id,page{id,name}", scope: "business_management" },
  owned_apps: { needs: "business", edge: (b) => `${b}/owned_apps`, fields: BIZ_ASSET, scope: "business_management" },
  client_apps: { needs: "business", edge: (b) => `${b}/client_apps`, fields: BIZ_ASSET, scope: "business_management" },
  pending_client_apps: { needs: "business", edge: (b) => `${b}/pending_client_apps`, fields: "id,application{id,name}", scope: "business_management" },
  owned_instagram_accounts: { needs: "business", edge: (b) => `${b}/owned_instagram_accounts`, fields: "id,username", scope: "business_management" },
  client_instagram_accounts: { needs: "business", edge: (b) => `${b}/instagram_accounts`, fields: "id,username", scope: "business_management" },
  owned_pixels: { needs: "business", edge: (b) => `${b}/owned_pixels`, fields: "id,name,last_fired_time", scope: "business_management" },
  client_offsite_signal_containers: { needs: "business", edge: (b) => `${b}/client_offsite_signal_container_business_objects`, fields: BIZ_ASSET, scope: "business_management" },
  owned_offsite_signal_containers: { needs: "business", edge: (b) => `${b}/owned_offsite_signal_container_business_objects`, fields: BIZ_ASSET, scope: "business_management" },
  pending_offsite_signal_containers: { needs: "business", edge: (b) => `${b}/pending_shared_offsite_signal_container_business_objects`, fields: BIZ_ASSET, scope: "business_management" },
  owned_businesses: { needs: "business", edge: (b) => `${b}/owned_businesses`, fields: BIZ_ASSET, scope: "business_management" },
  clients: { needs: "business", edge: (b) => `${b}/clients`, fields: BIZ_ASSET, scope: "business_management" },
  agencies: { needs: "business", edge: (b) => `${b}/agencies`, fields: BIZ_ASSET, scope: "business_management" },
  system_users: { needs: "business", edge: (b) => `${b}/system_users`, fields: PEOPLE, scope: "business_management" },
  business_users: { needs: "business", edge: (b) => `${b}/business_users`, fields: PEOPLE, scope: "business_management" },
  pending_users: { needs: "business", edge: (b) => `${b}/pending_users`, fields: "id,role,status", scope: "business_management" },
  invoices: {
    needs: "business",
    edge: (b) => `${b}/business_invoices`,
    fields: "id,invoice_id,invoice_date,due_date,amount_due,currency,payment_status,billing_period",
    scope: "business_management",
  },
  initiated_audience_sharing_requests: { needs: "business", edge: (b) => `${b}/initiated_audience_sharing_requests`, fields: "id,status", scope: "business_management" },
  received_audience_sharing_requests: { needs: "business", edge: (b) => `${b}/received_audience_sharing_requests`, fields: "id,status", scope: "business_management" },
  collaborative_ads_requests: { needs: "business", edge: (b) => `${b}/collaborative_ads_collaboration_requests`, fields: "id,brands,status", scope: "business_management" },
  collaborative_ads_partners: { needs: "business", edge: (b) => `${b}/collaborative_ads_suggested_partners`, fields: BIZ_ASSET, scope: "business_management" },
  managed_partner_funding: { needs: "business", edge: (b) => `${b}/managed_partner_ads_funding_source_details`, fields: "id,amount,currency,coupon_id", scope: "business_management" },
  account_agencies: { needs: "account", edge: (_i, a) => `${a}/agencies`, fields: BIZ_ASSET },
  account_subscribed_apps: { needs: "account", edge: (_i, a) => `${a}/subscribed_apps`, fields: "app_id,app_name" },
  video_thumbnails: { needs: "id", edge: (v) => `${v}/thumbnails`, fields: "id,uri,is_preferred,width,height" },
  video_tags: { needs: "id", edge: (v) => `${v}/tags`, fields: "id,name" },
};

export const OBJECT_FIELDS = new Set([
  "id", "name", "status", "configured_status", "effective_status", "account_id", "campaign_id", "adset_id",
  "created_time", "updated_time", "objective", "daily_budget", "lifetime_budget", "spend_cap", "start_time",
  "end_time", "stop_time", "bid_strategy", "bid_amount", "optimization_goal", "billing_event", "title",
  "length", "picture", "permalink_url", "category", "username",
]);

const TARGETING_TYPES = ["adinterest", "adgeolocation", "adeducationschool", "adworkemployer", "adworkposition", "adlocale"] as const;

const input = z.object({
  resource: z.enum([...Object.keys(RESOURCES), "object", "targeting_search"] as unknown as [string, ...string[]]),
  business_id: z.string().optional().describe("For business resources: from resource 'businesses'."),
  id: z.string().optional().describe("For video_thumbnails / video_tags / object."),
  fields: z.array(z.string()).optional().describe("object only: flat fields like name, status, daily_budget."),
  search_type: z.enum(TARGETING_TYPES).optional().describe("targeting_search: what to search."),
  q: z.string().optional().describe("targeting_search: the text to look up."),
  limit: z.number().int().min(1).max(100).optional(),
});

export const metaAccountReadTool: ToolSpec = {
  name: "meta_ads_account_read",
  effect: "read",
  description:
    "Read anything else in the founder's Meta setup: their ad accounts and Business Managers, a business's ad accounts, Pages, apps, Instagram accounts, pixels, partners, people (names and roles) and invoices; targeting search (interests, places, schools, employers, job titles, languages); video thumbnails and tags; or a plain object by id.",
  input_schema: input,
  async execute(ctx, raw) {
    const a = input.parse(raw);
    const limit = a.limit ?? 50;

    if (a.resource === "targeting_search") {
      if (!a.search_type || !a.q?.trim()) {
        throw new ExpectedToolError("meta_ads_invalid_read", "targeting_search needs search_type and q.");
      }
      const params: Record<string, string | number> = { type: a.search_type, q: a.q.trim(), limit };
      if (a.search_type === "adgeolocation") params.location_types = JSON.stringify(["country", "region", "city", "zip"]);
      const r = (await fbGet(ctx.tenant_id, "search", params)) as { data?: unknown[] };
      return { resource: a.resource, items: r.data ?? [] };
    }

    if (a.resource === "object") {
      if (!a.id || !/^[0-9_]{3,40}$|^act_\d+$/.test(a.id)) {
        throw new ExpectedToolError("meta_ads_invalid_read", "object needs a Meta id.");
      }
      const fields = (a.fields?.length ? a.fields : ["id", "name"]).filter((f) => OBJECT_FIELDS.has(f));
      if (fields.length === 0) {
        throw new ExpectedToolError("meta_ads_invalid_read", `object reads take flat fields only: ${[...OBJECT_FIELDS].join(", ")}.`);
      }
      return { resource: a.resource, item: await fbGet(ctx.tenant_id, a.id, { fields: fields.join(",") }) };
    }

    const res = RESOURCES[a.resource];
    let key = "";
    if (res.needs === "business") {
      if (!a.business_id || !/^\d{5,25}$/.test(a.business_id)) {
        throw new ExpectedToolError("meta_ads_invalid_read", `${a.resource} needs a business_id (from resource 'businesses').`);
      }
      key = a.business_id;
    } else if (res.needs === "id") {
      if (!a.id || !/^\d{5,25}$/.test(a.id)) throw new ExpectedToolError("meta_ads_invalid_read", `${a.resource} needs an id.`);
      key = a.id;
    }
    if (res.scope) await assertMetaScopes(ctx.tenant_id, [res.scope], `Reading ${a.resource.replace(/_/g, " ")}`);
    const account = res.needs === "account" ? (await metaAdsCreds(ctx.tenant_id)).ad_account_id : "";
    const r = (await fbGet(ctx.tenant_id, res.edge(key, account), { ...(res.fields ? { fields: res.fields } : {}), limit, ...(res.params ?? {}) })) as {
      data?: unknown[];
      paging?: { next?: string };
      id?: string;
    };
    return Array.isArray(r.data)
      ? { resource: a.resource, items: r.data, truncated: !!r.paging?.next }
      : { resource: a.resource, item: r };
  },
};
