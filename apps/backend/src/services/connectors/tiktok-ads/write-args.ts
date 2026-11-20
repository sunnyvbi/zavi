
import { ExpectedToolError } from "@/services/tools/types";
import { composioToolIsRead } from "@/services/connectors/composio/write-classify";
import { ensureAdAccounts, type AdAccountsState } from "./ad-accounts";

type Schema = { [k: string]: unknown } | undefined;
type Outcome = { ok: true; args: unknown } | { ok: false; code: string; message: string };

const PICK_ON_PAGE =
  "Ask the founder to choose their TikTok ad account on the TikTok Ads channel page (Ad account card), then try again. No request was sent and no approval was created.";

function describeAccounts(state: AdAccountsState): string {
  return state.accounts.map((a) => `${a.name} (${a.advertiser_id})`).join(", ");
}

export async function applyTiktokAdvertiser(
  tenantId: string,
  toolSlug: string,
  args: unknown,
  schema: Schema,
  load: (tenantId: string) => Promise<AdAccountsState> = ensureAdAccounts,
): Promise<Outcome> {
  if (!toolSlug.startsWith("TIKTOK_ADS_")) return { ok: true, args };
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) return { ok: true, args };
  const input = { ...((args ?? {}) as Record<string, unknown>) };
  const props = schema && typeof schema.properties === "object" && schema.properties !== null ? (schema.properties as Record<string, unknown>) : {};
  const takesOne = "advertiser_id" in props || "advertiser_id" in input;
  const takesMany = "advertiser_ids" in props || "advertiser_ids" in input;
  if (!takesOne && !takesMany) return { ok: true, args };

  let state: AdAccountsState;
  try {
    state = await load(tenantId);
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "tiktok_ads_token_revoked") {
      return { ok: false, code: e.code, message: "TikTok Ads needs to be reconnected. Ask the founder to reconnect it on the TikTok Ads channel page." };
    }
    return { ok: false, code: "tiktok_ads_accounts_unavailable", message: "Could not check the founder's TikTok ad accounts. Try again. No request was sent." };
  }
  if (!state.connected) return { ok: true, args };

  const write = !composioToolIsRead(toolSlug, "tiktok_ads", undefined);
  const known = new Set(state.accounts.map((a) => a.advertiser_id));
  const refuse = (ids: string[]): Outcome => ({
    ok: false,
    code: "tiktok_ads_unknown_account",
    message:
      `${ids.join(", ")} ${ids.length === 1 ? "is not one" : "are not"} of the founder's TikTok ad accounts: ${describeAccounts(state) || "none saved yet"}. ` +
      "An account their TikTok login reaches but not listed here can be added on the TikTok Ads channel page (Ad account card). No request was sent.",
  });

  if (takesOne) {
    const supplied = input.advertiser_id;
    if (supplied === undefined || supplied === null || supplied === "") {
      if (!state.selected_id) return { ok: false, code: "tiktok_ads_account_not_chosen", message: PICK_ON_PAGE };
      input.advertiser_id = state.selected_id;
    } else if (!known.has(String(supplied))) {
      return known.size ? refuse([String(supplied)]) : { ok: false, code: "tiktok_ads_account_not_chosen", message: PICK_ON_PAGE };
    } else {
      input.advertiser_id = String(supplied);
    }
  }
  const required = schema?.required;
  const manyRequired = Array.isArray(required) && required.includes("advertiser_ids");
  const fill = write ? (state.selected_id ? [state.selected_id] : []) : [...known];
  const noneGiven = input.advertiser_ids === undefined || (Array.isArray(input.advertiser_ids) && input.advertiser_ids.length === 0);
  if (manyRequired && noneGiven) {
    if (!fill.length) return write ? { ok: false, code: "tiktok_ads_account_not_chosen", message: PICK_ON_PAGE } : { ok: true, args: input };
    input.advertiser_ids = fill;
  }
  if (takesMany && input.advertiser_ids !== undefined && !Array.isArray(input.advertiser_ids)) {
    return { ok: false, code: "tiktok_ads_bad_account_id", message: "advertiser_ids must be a list of the founder's ad account IDs. No request was sent." };
  }
  if (takesMany && Array.isArray(input.advertiser_ids)) {
    const outside = input.advertiser_ids.map(String).filter((id) => !known.has(id));
    if (outside.length) return refuse(outside);
  }
  return { ok: true, args: input };
}
