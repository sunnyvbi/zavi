
import { recipeFindings, type RecipeFindingView } from "./recipeStep";

export type Handoff = {
  who: string;
  detail: string;
};

export function findingHandoff(access: RecipeFindingView["access"]): Handoff {
  switch (access) {
    case "none":
      return {
        who: "No site access needed",
        detail:
          "Nothing here needs a change to your site's code or hosting, so this one is not waiting on access to anything.",
      };
    case "cdn":
      return {
        who: "You, at your CDN or DNS",
        detail:
          "This is served before your code runs, so a change in your repo cannot reach it. Connecting a repo does not help: it has to change where the site is served from, such as Cloudflare, Vercel or Netlify.",
      };
    case "repo":
      return {
        who: "You, in your site's code",
        detail:
          "This is a change in the code your site is built from. Zavi has no write path to your site, so this one is yours to make, and the action below is the instruction.",
      };
    default:
      return {
        who: "Not established",
        detail:
          "Zavi did not determine which access this needs, so it is not saying who has to act. The action below is what it would take.",
      };
  }
}

export function handoffFindings(findings: RecipeFindingView[]): RecipeFindingView[] {
  return findings
    .filter((f) => {
      if (f.status === "measured") return false;
      if (f.status === "failing") return true;
      return (
        f.blocks.length > 0 || !!f.access || !!f.doNothing || !!f.undo || !!f.risk
      );
    })
    .slice(0, HANDOFF_TOTAL_LIMIT);
}

export const HANDOFF_CARD_LIMIT = 2;

export const HANDOFF_TOTAL_LIMIT = 8;

export function runFindings(
  actions: readonly { body: Record<string, unknown> }[],
): RecipeFindingView[] {
  for (const a of actions) {
    const found = recipeFindings(a.body);
    if (found.length > 0) return found;
  }
  return [];
}
