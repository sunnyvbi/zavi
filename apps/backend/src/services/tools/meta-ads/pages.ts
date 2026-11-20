
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { fbGet } from "./_client";
import { assertMetaScopes } from "./_scopes";

type ManagedPage = { id?: string; name?: string; category?: string; tasks?: string[]; access_token?: string };

async function managedPages(tenant_id: string): Promise<ManagedPage[]> {
  const r = (await fbGet(tenant_id, "me/accounts", { fields: "id,name,category,tasks,access_token", limit: 100 })) as { data?: ManagedPage[] };
  return r.data ?? [];
}

export async function pageAccessToken(tenant_id: string, page_id: string): Promise<string> {
  const page = (await managedPages(tenant_id)).find((p) => p.id === page_id);
  if (!page?.access_token) {
    throw new ExpectedToolError("meta_ads_page_not_managed", `Page ${page_id} is not one the connected Facebook user manages; nothing was sent.`);
  }
  const tasks = new Set(page.tasks ?? []);
  if (!tasks.has("ADVERTISE") && !tasks.has("MANAGE")) {
    throw new ExpectedToolError("meta_ads_page_role_missing", `The connected user cannot advertise for Page ${page_id}; nothing was sent.`);
  }
  return page.access_token;
}

const pagesInput = z.object({});

export const metaListPagesTool: ToolSpec = {
  name: "meta_ads_list_pages",
  effect: "read",
  description: "List the Facebook Pages the connected Meta user manages (id, name, category, what they may do on each). Lead forms and ads run on a Page.",
  input_schema: pagesInput,
  async execute(ctx) {
    await assertMetaScopes(ctx.tenant_id, ["pages_show_list"], "Listing Pages");
    const pages = await managedPages(ctx.tenant_id);
    return { pages: pages.map(({ id, name, category, tasks }) => ({ id, name, category, tasks: tasks ?? [] })) };
  },
};

const formsInput = z.object({ page_id: z.string().min(1).describe("From list_pages this turn.") });

export const metaListLeadFormsTool: ToolSpec = {
  name: "meta_ads_list_lead_forms",
  effect: "read",
  description:
    "List a Page's lead forms: name, status, questions and how many leads each has collected. Never the leads themselves.",
  input_schema: formsInput,
  async execute(ctx, input) {
    const a = formsInput.parse(input);
    await assertMetaScopes(ctx.tenant_id, ["pages_manage_ads", "leads_retrieval"], "Reading lead forms");
    const token = await pageAccessToken(ctx.tenant_id, a.page_id);
    const r = (await fbGet(
      ctx.tenant_id,
      `${a.page_id}/leadgen_forms`,
      { fields: "id,name,status,locale,leads_count,created_time,questions{type,key,label}", limit: 100 },
      { page_access_token: token },
    )) as { data?: Array<Record<string, unknown>>; paging?: { next?: string } };
    return { page_id: a.page_id, forms: r.data ?? [], truncated: !!r.paging?.next };
  },
};
