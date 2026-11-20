
type TypeInfo = { name: string; changes: string };

const RECOMMENDATION_TYPES: Readonly<Record<string, TypeInfo>> = {
  CAMPAIGN_BUDGET: { name: "Raise budgets", changes: "raises campaign daily budgets" },
  MARGINAL_ROI_CAMPAIGN_BUDGET: { name: "Adjust budgets for return", changes: "changes campaign daily budgets" },
  FORECASTING_CAMPAIGN_BUDGET: { name: "Raise budgets ahead of demand", changes: "raises campaign daily budgets" },
  MOVE_UNUSED_BUDGET: { name: "Move unused budget", changes: "moves budget between campaigns" },
  KEYWORD: { name: "Add new keywords", changes: "adds keywords" },
  KEYWORD_MATCH_TYPE: { name: "Broaden keyword match types", changes: "changes keywords to broader match types" },
  USE_BROAD_MATCH_KEYWORD: { name: "Add broad match keywords", changes: "adds broad match versions of keywords" },
  TARGET_CPA_OPT_IN: { name: "Switch to Target CPA", changes: "changes the bidding strategy" },
  TARGET_ROAS_OPT_IN: { name: "Switch to Target ROAS", changes: "changes the bidding strategy" },
  MAXIMIZE_CONVERSIONS_OPT_IN: { name: "Switch to Maximize Conversions", changes: "changes the bidding strategy" },
  MAXIMIZE_CONVERSION_VALUE_OPT_IN: { name: "Switch to Maximize Conversion Value", changes: "changes the bidding strategy" },
  MAXIMIZE_CLICKS_OPT_IN: { name: "Switch to Maximize Clicks", changes: "changes the bidding strategy" },
  ENHANCED_CPC_OPT_IN: { name: "Turn on Enhanced CPC", changes: "changes the bidding strategy" },
  SET_TARGET_CPA: { name: "Set a target CPA", changes: "sets a target cost per conversion" },
  SET_TARGET_ROAS: { name: "Set a target ROAS", changes: "sets a target return on ad spend" },
  RAISE_TARGET_CPA: { name: "Raise target CPA", changes: "raises the target cost per conversion" },
  LOWER_TARGET_ROAS: { name: "Lower target ROAS", changes: "lowers the target return on ad spend" },
  SEARCH_PARTNERS_OPT_IN: { name: "Show ads on search partners", changes: "turns on the Search Partners network" },
  DISPLAY_EXPANSION_OPT_IN: { name: "Expand to Display", changes: "turns on Display expansion for Search campaigns" },
  RESPONSIVE_SEARCH_AD: { name: "Add responsive search ads", changes: "adds new ads" },
  RESPONSIVE_SEARCH_AD_ASSET: { name: "Add ad headlines and descriptions", changes: "adds headlines and descriptions to ads" },
  OPTIMIZE_AD_ROTATION: { name: "Optimize ad rotation", changes: "changes how ads rotate" },
  SITELINK_ASSET: { name: "Add sitelinks", changes: "adds sitelink assets" },
  CALLOUT_ASSET: { name: "Add callouts", changes: "adds callout assets" },
  CALL_ASSET: { name: "Add call assets", changes: "adds a phone number to ads" },
};

export function recommendationTypeInfo(type: string): { name: string; changes: string | null; mapped: boolean } {
  const known = RECOMMENDATION_TYPES[type];
  if (known) return { ...known, mapped: true };
  const words = type.toLowerCase().split("_").filter(Boolean).join(" ");
  return { name: words ? words[0].toUpperCase() + words.slice(1) : type, changes: null, mapped: false };
}
