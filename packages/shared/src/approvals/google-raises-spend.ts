
export function googleActionRaisesSpend(cls: string | null | undefined, body: unknown): boolean {
  if (typeof cls !== "string" || !cls.startsWith("google_ads.")) return false;
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  switch (cls) {
    case "google_ads.update_campaign_budget":
    case "google_ads.update_campaign_budget_review": {
      const to = n(b.daily_budget_usd);
      const from = n(b.expected_current_daily_budget_usd);
      return to === null || from === null || to > from;
    }
    case "google_ads.set_status":
    case "google_ads.set_status_review":
      return b.status !== "PAUSED";
    case "google_ads.create_campaign":
    case "google_ads.create_ad_group":
    case "google_ads.create_ad":
      return true;
    case "google_ads.add_keywords":
      return b.negative !== true;
    case "google_ads.update_campaign":
      return !onlyChanges(b, ["new_name"]);
    case "google_ads.update_ad_group":
      return !onlyChanges(b, ["new_name"]);
    case "google_ads.remove_resource":
      return removalRaisesSpend(b);
    default:
      return true;
  }
}

const NOT_A_CHANGE: ReadonlySet<string> = new Set([
  "campaign_id",
  "ad_group_id",
  "rationale",
  "name",
  "about",
  "origin",
  "decision_evidence",
  "cut_guard_note",
  "on_goal_hint",
  "founder_chat_order",
  "founder_order_unverified",
  "move_group",
  "run_alone",
  "object_daily_budget",
  "object_status",
  "verified_name",
  "match_unsure",
]);

function onlyChanges(b: Record<string, unknown>, allowed: readonly string[]): boolean {
  const changes = Object.keys(b).filter((k) => !NOT_A_CHANGE.has(k) && b[k] !== undefined);
  return changes.length > 0 && changes.every((k) => allowed.includes(k));
}

const isId = (v: unknown): boolean => typeof v === "string" && /^[0-9]+$/.test(v);

function removalRaisesSpend(b: Record<string, unknown>): boolean {
  switch (b.level) {
    case "campaign":
      return !isId(b.campaign_id);
    case "ad_group":
      return !isId(b.ad_group_id);
    case "ad":
      return !(isId(b.ad_group_id) && isId(b.ad_id));
    case "keyword":
      return b.criterion_negative !== false;
    default:
      return true;
  }
}
