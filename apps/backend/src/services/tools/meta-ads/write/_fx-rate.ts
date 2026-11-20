
import { ExpectedToolError } from "@/services/tools/types";
import { globalClient } from "@/services/tenant-client";
import { assertWritableCurrency, unitsPerUsdFromBlob } from "./_currency";

export async function unitsPerUsd(currency: string): Promise<number> {
  const c = assertWritableCurrency(currency);
  if (c === "USD") return 1;
  const { data, error } = await globalClient()
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle<{ blob: unknown }>();
  if (error) {
    throw new ExpectedToolError("meta_ads_fx_unavailable", `Could not read the ${c} exchange rate: ${error.message}`);
  }
  const rate = unitsPerUsdFromBlob(data?.blob ?? null, c);
  if (rate == null) {
    throw new ExpectedToolError("meta_ads_fx_unavailable", `No exchange rate is set for ${c}.`);
  }
  return rate;
}
