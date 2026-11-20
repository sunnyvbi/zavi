
export function chatgptActionRaisesSpend(cls: string | null | undefined, body: unknown): boolean {
  if (typeof cls !== "string" || !cls.startsWith("chatgpt_ads.")) return false;
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  switch (cls) {
    case "chatgpt_ads.set_status":
      return b.status !== "PAUSED";
    case "chatgpt_ads.update_campaign_budget": {
      const to = b.daily_budget_usd, from = b.expected_current_daily_budget_usd;
      return !(typeof to === "number" && typeof from === "number" && Number.isFinite(to) && Number.isFinite(from) && to <= from);
    }
    default:
      return true;
  }
}
