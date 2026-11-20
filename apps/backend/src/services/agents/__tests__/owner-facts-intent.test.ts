import { describe, expect, it } from "vitest";
import { isAppEditIntent, isOwnerFactsStatement, isSiteChatEditIntent } from "../app-edit-intent";

const FACTS = [
  "We charge $80 for a standard clean and $140 for a deep clean",
  "Our prices start at $80",
  "Standard clean is $80 per visit, deep clean $140",
  "It costs £45 an hour",
  "Pricing: from 1,200 rupees for a 1BHK",
  "Our hours are 9am to 6pm, Monday to Saturday",
  "We're open 8am-5pm on weekdays",
  "Mon-Fri 9 to 5, Sat 10 to 2",
  "We serve San Jose, Santa Clara and Sunnyvale",
  "Our service area is the South Bay",
  "I cover all of Austin within 20 miles",
];

const NOT_FACTS = [
  "What should our prices be?",
  "How much do you charge?",
  "Are we open on Sundays?",
  "Write an ad that says we charge $80",
  "Make me a report on prices we charge",
  "Let's discuss our hours",
  "The build is taking a while",
  "I spent $80 on ads last month",
  "We have 3 cleaners",
];

describe("owner facts typed in a site's chat", () => {
  it("prices, hours and service areas are recognised and routed to the site", () => {
    for (const s of FACTS) {
      expect(isOwnerFactsStatement(s), s).toBe(true);
      expect(isSiteChatEditIntent(s), s).toBe(true);
    }
  });

  it("questions, off-site asks and other numbers are not", () => {
    for (const s of NOT_FACTS) {
      expect(isOwnerFactsStatement(s), s).toBe(false);
    }
    for (const s of NOT_FACTS.slice(0, 6)) expect(isSiteChatEditIntent(s), s).toBe(false);
  });

  it("only a site's own chat reads facts as a change: the general app classifier is unchanged", () => {
    for (const s of ["We serve San Jose, Santa Clara and Sunnyvale", "Our hours are 9am to 6pm, Monday to Saturday"]) {
      expect(isAppEditIntent(s), s).toBe(false);
    }
  });
});
