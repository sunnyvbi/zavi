import type { TopActionSpec } from "../../platformSpec";
import { ABOUT, APPROVAL, EXCLUDE_PLACES, GOAL, INCLUDE_PLACES, LINK, NEW_CAMPAIGN_BUDGET, WHERE } from "../fieldSets";

export const META_CREATE: TopActionSpec = {
  key: "create_new_ad",
  label: "Create new ad",
  modal: "plan",
  fields: [
    ABOUT,
    LINK,
    GOAL,
    {
      kind: "choice",
      name: "placement",
      label: "Shows on",
      initial: "both",
      options: [
        { id: "both", label: "Facebook and Instagram", sub: "Meta picks what works." },
        { id: "ig", label: "Instagram only", sub: "Feed, Stories, Reels." },
        { id: "fb", label: "Facebook only", sub: "Feed, Marketplace." },
      ],
    },
    NEW_CAMPAIGN_BUDGET,
    INCLUDE_PLACES,
    EXCLUDE_PLACES,
  ],
};

export const GOOGLE_CREATE: TopActionSpec = {
  key: "create_new_ad",
  label: "Create new ad",
  modal: "plan",
  hint: "Created paused. Nothing goes live until you approve and turn it on.",
  fields: [ABOUT, LINK, GOAL, NEW_CAMPAIGN_BUDGET, { ...WHERE, label: "Include locations" }, EXCLUDE_PLACES],
};

export const GOOGLE_ADD_KEYWORDS: TopActionSpec = {
  key: "add_keywords",
  label: "Add keywords",
  modal: "plan",
  lead: "Zavi finds searches people make for what you sell and proposes keywords for an ad group.",
  primary: "Find keywords",
  note: `${APPROVAL} Approved keywords start showing in that ad group right away when it is on.`,
  fields: [
    { kind: "select", name: "ad_group_id", label: "Ad group", from: "ad_groups", empty: "No Search ad groups found in your Google Ads account." },
    { kind: "area", name: "ideas", label: "Ideas to start from (optional)", placeholder: "brand terms, product category, customer problem", max: 300, optional: true },
  ],
};
