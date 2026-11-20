import { describe, it, expect } from "vitest";
import { detectPunt, detectRecordAsk, isResearchAsk } from "../punt-detector";

describe("detectPunt — catch set", () => {
  const CATCH: Array<[string, string]> = [
    [
      "I can't trigger a live test run from here. Go to zaviagent.com/start and do it yourself, it takes about a minute.",
      "cant_from_here",
    ],
    ["Go to zaviagent.com/start yourself and paste in vercel.com.", "do_it_yourself"],
    ["You'll need to open the page yourself to see the new pricing table.", "do_it_yourself"],
    ["You will need to run the Lighthouse check yourself.", "do_it_yourself"],
    ["You'll have to visit the site yourself, then tell me what you see.", "do_it_yourself"],
    ["Please open vercel.com yourself and send me a screenshot.", "do_it_yourself"],
    ["I’m unable to open that URL from here.", "cant_from_here"],
    ["I cannot browse to your landing page from this thread.", "cant_from_here"],
    ["Unfortunately I can't access the live site from Slack.", "cant_from_here"],
    ["That page is not reachable from my tools.", "tools_unreachable"],
    ["I don't have a browser, so I can't look at the checkout flow.", "no_browser"],
    ["I do not have browser access in this conversation.", "no_browser"],
    ["I can't access the code from here.", "cant_from_here"],
    ["I can't open the deployment from here to verify it.", "cant_from_here"],
  ];
  for (const [text, cls] of CATCH) {
    it(`catches: ${text.slice(0, 60)}`, () => {
      const r = detectPunt(text);
      expect(r.punt).toBe(true);
      expect(r.matched).toBe(cls);
    });
  }
});

describe("detectPunt — must-not-touch (real honest outputs)", () => {
  const HONEST: string[] = [
    "The TikTok Commercial Content Library only covers EU/UK ads, so US ads aren't visible. I pulled the 14 EU ads it does show below.",
    "Connect your Stripe account in Settings → Connectors so I can read disputes.",
    "I can't access your Stripe data from here until Stripe is connected. Connect it in Settings → Connectors and I'll pull the disputes.",
    "Go to Settings → Connectors and connect Google Ads yourself — I can't do the OAuth step for you.",
    "You'll need to open your registrar yourself to verify that you own the domain.",
    "You'll need to approve the card before it goes live.",
    "I drafted the budget change. Approve it yourself in the card above and it ships.",
    "You'll need to verify your domain in Google Search Console.",
    "You'll need to verify your domain in Google Search Console yourself, since only the owner can add the TXT record.",
    "You'll need to log in to Shopify and enter the code we texted you.",
    "I can't log in to your bank from here; you'll need to enter the 2FA code yourself.",
    "I ran the site check on vercel.com: 82/100. The biggest fix is a missing meta description on /pricing.",
    "Signups are up 12% week over week, driven by the Reddit thread on Tuesday.",
    "Here's the report. You can open it yourself anytime from the link below, and I'll refresh it Monday.",
    "",
  ];
  for (const text of HONEST) {
    it(`leaves alone: ${text.slice(0, 60) || "(empty)"}`, () => {
      expect(detectPunt(text).punt).toBe(false);
    });
  }
});

describe("detectRecordAsk", () => {
  const CATCH = [
    "The fastest way to settle it is the Jeep's listing ID, or its listing in the admin dashboard. With that I can check whether it has a wrong location or area tag, or whether the search is ignoring location for long-term cars. Can you send the ID, or should I have the engineer trace it from the screenshot?",
    "**Recommended next action:** send the Jeep's listing ID so I can check its location and area tag.",
    "Could you share the order number so I can look at it?",
    "If you paste the user ID I can check their account.",
    "Please send me the booking link.",
    "What is the listing ID for the red pickup in the screenshot?",
    "Could you share the link to the listing?",
  ];
  for (const text of CATCH) {
    it(`catches: ${text.slice(0, 60)}`, () => {
      expect(detectRecordAsk(text)).toBe(true);
    });
  }

  const LEAVE = [
    "Can you send me your API password so I can connect it?",
    "Could you share the verification code we texted you?",
    "Which city do you mean, Newark NJ or Newark CA?",
    "I found listing ID 104401: its map pin is in Fremont while the address says Miami.",
    "I'll send the ID to the engineer once the check finishes.",
    "Want me to post the summary to #ops?",
    "Share your thoughts on these ideas when you have a minute.",
    "Could you share whether you mean invoice ID in_A or in_B?",
    "Which order do you mean, #1182 or #1190?",
    "What is the user ID field used for in the checkout code.",
    "",
  ];
  for (const text of LEAVE) {
    it(`leaves alone: ${text.slice(0, 60) || "(empty)"}`, () => {
      expect(detectRecordAsk(text)).toBe(false);
    });
  }
});

describe("isResearchAsk", () => {
  it.each([
    "top creator platforms for my product",
    "is ChatGPT ads a fit for us?",
    "would TikTok be a good fit",
    "Klaviyo vs Mailchimp for a small shop",
    "what are the best tools for UGC briefs",
    "what is Meta's current ad policy on supplements",
    "how much does LinkedIn ads cost per click",
    "how does ChatGPT ads work",
    "alternatives to Billo",
  ])("research: %s", (q) => expect(isResearchAsk(q)).toBe(true));

  it.each([
    "write me a UGC brief for the new feature",
    "how many signups did we get this week vs last week?",
    "how does our checkout work",
    "post this to Instagram",
    "what is our best performing ad",
    "will the logo fit in the header",
    "what's the difference between our Basic and Pro plans?",
    "is this candidate a good fit?",
    "is fixing this bug worth it?",
    "how much does it cost",
    "how much does the Growth plan cost?",
    "how much would this campaign cost",
    "how does the checkout work",
    "how do credits work",
    "what is our best channel",
    "our Starter vs Growth plan",
    "what is the difference between the Basic and Pro plans",
    "",
  ])("not research: %s", (q) => expect(isResearchAsk(q)).toBe(false));
});
