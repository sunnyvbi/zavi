
const BID_WORDS: Record<string, string> = {
  LOWEST_COST_WITH_BID_CAP: "bid cap",
  COST_CAP: "cost per result goal",
  LOWEST_COST_WITH_MIN_ROAS: "minimum ROAS",
};

export function metaNewAdSetBidPhrase(body: Record<string, unknown>, money: (n: number) => string): string | null {
  const strategy = typeof body.campaign_bid_strategy === "string" ? body.campaign_bid_strategy : typeof body.bid_strategy === "string" ? body.bid_strategy : null;
  const words = strategy ? BID_WORDS[strategy] : undefined;
  if (!words) return null;
  const amount = typeof body.bid_amount_usd === "number" && Number.isFinite(body.bid_amount_usd) ? body.bid_amount_usd : null;
  const roas = typeof body.roas_floor === "number" && Number.isFinite(body.roas_floor) ? body.roas_floor : null;
  const value = strategy === "LOWEST_COST_WITH_MIN_ROAS" ? (roas !== null ? `${roas}x` : null) : amount !== null ? money(amount) : null;
  if (value === null) return null;
  const from = body.bid_copied_from as { ad_sets?: unknown; result?: unknown } | undefined;
  const n = typeof from?.ad_sets === "number" ? from.ad_sets : null;
  const result = typeof from?.result === "string" ? from.result : null;
  const source = n !== null && result ? (n === 1 ? `, copied from the campaign's ad set for ${result}` : `, picked from the campaign's ${n} ad sets for ${result}`) : "";
  return `a ${words} of ${value}${source}`;
}
