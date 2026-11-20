
import type { TopActionField } from "../platformSpec";

export const ABOUT: TopActionField = { kind: "text", name: "about", label: "What is the ad about?", max: 300, error: "Say what the ad is about." };

export const LINK = { kind: "url" as const, name: "link", label: "Link", hint: "Where people land when they tap the ad. Starts with https://" } satisfies TopActionField;

export const GOAL: TopActionField = {
  kind: "choice",
  name: "goal",
  label: "What should people do?",
  initial: "visit",
  options: [
    { id: "visit", label: "Visit my site", sub: "People click through to a page." },
    { id: "buy", label: "Buy or sign up", sub: "Counted by your tracking on the site." },
  ],
};

export const NEW_CAMPAIGN_BUDGET: TopActionField = {
  kind: "money",
  name: "daily_budget",
  label: "Daily budget",
  initial: "20",
  perDay: true,
  hint: "Only used if Zavi needs a new campaign, in your ad account's currency{currency}. Counts against your monthly ad budget.",
};

export function dailyBudget(hint: string, initial = "20", above = 0): TopActionField {
  return { kind: "money", name: "daily_budget", label: "Daily budget", initial, perDay: true, above, hint };
}

export const WHERE: TopActionField = {
  kind: "places",
  name: "places",
  label: "Where",
  from: "places",
  hint: "Cities, regions or countries. Starts with your business's country.",
};

export const INCLUDE_PLACES: TopActionField = {
  kind: "places",
  name: "places",
  label: "Include locations",
  optional: true,
  hint: "Cities, regions or countries. Leave empty and Zavi uses where your ads already run, or your business's country.",
};

export const EXCLUDE_PLACES: TopActionField = {
  kind: "places",
  name: "excluded_places",
  label: "Exclude locations",
  optional: true,
  hint: "Cities, regions or countries the ads never show in.",
};

export const APPROVAL = "Goes to your list first. Nothing changes on the platform until you approve.";

export const TOPIC: TopActionField = { kind: "text", name: "topic", label: "Topic (optional)", optional: true, max: 200 };

export const POST_IMAGE: TopActionField = { kind: "image", name: "image_path", label: "Image" };

export function postTextOrZavi(label: string, max: number, measure?: (text: string) => number): TopActionField {
  return { kind: "area", name: "text", label: `${label} (optional)`, max, ...(measure ? { measure } : {}), optional: true, placeholder: "Leave empty and Zavi writes it" };
}

export const COMMUNITY: TopActionField = {
  kind: "text",
  name: "community",
  label: "Community",
  placeholder: "r/smallbusiness",
  accepts: "subreddit",
  error: "Enter a community like r/smallbusiness.",
};

export const POST_APPROVAL = "It waits for your approval on this page. Nothing posts until you approve it.";
