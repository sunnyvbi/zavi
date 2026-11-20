import { describe, expect, it } from "vitest";
import { redditCopyIssue } from "../channel-recipe-step";
import { draftIssue } from "@/services/channels/reddit/draft";

const base = "We tried three tools before settling on one. ";

describe("Reddit copy placeholder check", () => {
  it.each([
    "I keep a simple todo list for every client and tick it off before invoicing.",
    "A shared todo app plus a weekly review fixed it for our team, honestly.",
  ])("lets ordinary words through: %s", (copy) => {
    expect(redditCopyIssue(base + copy)).toBeNull();
    expect(draftIssue(base + copy, { companyNames: [], mayName: false, mayLink: false })).toBeNull();
  });

  it.each([
    "TODO: add the pricing link here before posting this reply.",
    "Our numbers are TBD until the next quarter closes, sorry.",
    "Pricing: tbd, we will share it once the beta closes.",
    "Check out [insert product name] for this exact problem.",
    "Here is the link: <insert link> which explains the setup.",
    "Use [Placeholder: company name] and you are set up.",
  ])("still catches a real placeholder: %s", (copy) => {
    expect(redditCopyIssue(base + copy)).toBe("Reddit copy contains an unfinished placeholder");
  });
});
