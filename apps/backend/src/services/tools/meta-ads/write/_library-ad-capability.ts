
import { fbGet, metaAdsCreds } from "../_client";
import { ExpectedToolError } from "@/services/tools/types";

export const REQUIRED_PAGE_PERMISSIONS = ["pages_show_list", "pages_manage_ads"] as const;

const WRITE_TASKS = new Set(["MANAGE", "ADVERTISE"]);

const AD_ACCOUNT_STATUS_ACTIVE = 1;

export type MetaAdBlockReason =
  | "connector_missing"
  | "account_not_writable"
  | "page_permission_missing"
  | "no_page"
  | "token_expired"
  | "meta_busy"
  | "lookup_failed";

export type MetaAdCapability =
  | {
      ok: true;
      ad_account_id: string;
      page_id: string;
      page_name: string | null;
      ad_sets: Array<{ id: string; name: string; status: string | null }>;
    }
  | { ok: false; reason_code: MetaAdBlockReason; reason: string };

export const BLOCK_REASON_TEXT: Record<MetaAdBlockReason, string> = {
  connector_missing:
    "Meta Ads is not connected for this workspace, so the video cannot be uploaded there. Download it and upload it yourself, or connect Meta Ads in workspace settings.",
  account_not_writable:
    "The connected Meta ad account is not writable right now: the account is inactive (check its status and billing in Meta), or this login only has read access (restore the role in Meta Business Settings). Download the video and upload it yourself.",
  page_permission_missing:
    "The Meta connection does not have access to your Facebook Page yet, and a video ad needs it. Reconnect Meta Ads in workspace settings and allow Page access, or download the video and upload it yourself.",
  no_page:
    "This Meta ad account has no Facebook Page it can promote. A video ad needs one. Download the video and upload it yourself, or add a Page to the ad account in Meta Business Settings.",
  token_expired:
    "The Meta connection has expired or was signed out. Reconnect Meta Ads in workspace settings, or download the video and upload it yourself.",
  meta_busy:
    "Meta is rate limiting this ad account right now. Try again in a few minutes, or download the video and upload it yourself.",
  lookup_failed:
    "Zavi could not check the Meta connection just now. Download the video and upload it yourself, or try again later.",
};

function blocked(reason_code: MetaAdBlockReason): MetaAdCapability {
  return { ok: false, reason_code, reason: BLOCK_REASON_TEXT[reason_code] };
}

export async function resolveMetaAdCapability(tenant_id: string): Promise<MetaAdCapability> {
  let ad_account_id: string;
  try {
    ad_account_id = (await metaAdsCreds(tenant_id)).ad_account_id;
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "meta_ads_not_connected") {
      return blocked("connector_missing");
    }
    return blocked("lookup_failed");
  }

  try {
    const account = (await fbGet(tenant_id, ad_account_id, {
      fields: "account_status,user_tasks,name",
    })) as { account_status?: number; user_tasks?: string[] };

    if (account.account_status !== AD_ACCOUNT_STATUS_ACTIVE) {
      return blocked("account_not_writable");
    }
    if (Array.isArray(account.user_tasks) && !account.user_tasks.some((t) => WRITE_TASKS.has(t))) {
      return blocked("account_not_writable");
    }
  } catch (e) {
    return blocked(classifyAccountLookupFailure(e));
  }

  try {
    const perms = (await fbGet(tenant_id, "me/permissions", {})) as {
      data?: Array<{ permission?: string; status?: string }>;
    };
    const granted = new Set(
      (perms.data ?? [])
        .filter((p) => p.status === "granted" && typeof p.permission === "string")
        .map((p) => p.permission as string),
    );
    if (!REQUIRED_PAGE_PERMISSIONS.every((p) => granted.has(p))) {
      return blocked("page_permission_missing");
    }
  } catch (e) {
    return blocked(classifyPageLookupFailure(e));
  }

  let page_id: string;
  let page_name: string | null;
  try {
    const pages = (await fbGet(tenant_id, `${ad_account_id}/promote_pages`, {
      fields: "id,name",
      limit: 25,
    })) as { data?: Array<{ id?: string; name?: string }> };
    const first = (pages.data ?? []).find((p) => typeof p.id === "string" && p.id.length > 0);
    if (!first?.id) return blocked("no_page");
    page_id = first.id;
    page_name = first.name ?? null;
  } catch (e) {
    return blocked(classifyPageLookupFailure(e));
  }

  let ad_sets: Array<{ id: string; name: string; status: string | null }> = [];
  try {
    const sets = (await fbGet(tenant_id, `${ad_account_id}/adsets`, {
      fields: "id,name,status",
      limit: 50,
    })) as { data?: Array<{ id?: string; name?: string; status?: string }> };
    ad_sets = (sets.data ?? [])
      .filter((s): s is { id: string; name?: string; status?: string } => typeof s.id === "string")
      .map((s) => ({ id: s.id, name: s.name ?? s.id, status: s.status ?? null }));
  } catch (e) {
    return blocked(classifyAccountLookupFailure(e));
  }

  return { ok: true, ad_account_id, page_id, page_name, ad_sets };
}

export function classifyPageLookupFailure(e: unknown): MetaAdBlockReason {
  if (e instanceof ExpectedToolError) {
    if (e.code === "meta_ads_permission_revoked") return "page_permission_missing";
    if (e.code === "meta_ads_token_expired") return "token_expired";
    if (e.code === "meta_ads_busy") return "meta_busy";
  }
  return "lookup_failed";
}

export function classifyAccountLookupFailure(e: unknown): MetaAdBlockReason {
  if (e instanceof ExpectedToolError) {
    if (e.code === "meta_ads_permission_revoked") return "account_not_writable";
    if (e.code === "meta_ads_token_expired") return "token_expired";
    if (e.code === "meta_ads_busy") return "meta_busy";
  }
  return "lookup_failed";
}
