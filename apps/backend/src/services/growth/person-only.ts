
export function isPersonOnlyOrigin(origin: unknown): boolean {
  return (
    origin === "user_initiated_chat" ||
    origin === "user_initiated_ledger" ||
    origin === "cut_guard_override" ||
    origin === "x_organic_trial" ||
    origin === "zavi_location_proposal" ||
    origin === "zavi_location_undo"
  );
}

export const PERSON_ONLY_EXEC_CLASSES: ReadonlySet<string> = new Set(["meta_ads.pause_past_cut_guard", "meta_ads.replace_ad_set_geo_review"]);
