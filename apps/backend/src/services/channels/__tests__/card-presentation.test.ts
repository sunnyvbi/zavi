import { describe, it, expect } from "vitest";
import { ACTION_TYPES, CHANNELS, DESTINATIONS } from "@zavi/shared";
import { DELIVERABLE_KINDS } from "@/agents/lib/channel-recipe-step";
import { AUDIENCE_REVIEW_STEPS, CARD_KINDS, DONE_WORDS, asksFounderForAnswer, cardPresentation, cardRole, listLines, nameCrossRefs, type CardPresentationInput } from "../card-presentation";
import { SITE_BUILDERS } from "../site-builder-markers";
import { backfillPresentation } from "../card-backfill";

const base: CardPresentationInput = {
  channelSlug: "seo",
  action_type: "fix",
  executable: false,
  deliverableKind: null,
  hasContent: true,
  stepBody: null,
  link: null,
  siteBuilder: "unknown",
};
const cp = (o: Partial<CardPresentationInput>) => cardPresentation({ ...base, ...o });

describe("cardPresentation: one fixture per kind, across channel families", () => {
  it("executes (paid): the money button keeps its fixed per-type words", () => {
    expect(cp({ channelSlug: "google_ads", action_type: "update_ad", executable: true })).toMatchObject({
      card_kind: "executes",
      primary_label: "Apply change",
    });
    expect(
      cp({
        channelSlug: "meta_ads",
        action_type: "update_ad",
        executable: true,
        rows: [{ item: "Daily budget", before: "$10", after: "$20" }],
      }).primary_label,
    ).toBe("Adjust budget");
    expect(cp({ channelSlug: "meta_ads", action_type: "pause_ad", executable: true }).primary_label).toBe("Pause");
  });

  it("executes (email tool): the button says how many people the email goes to", () => {
    const rows = [
      { item: "Subject", before: "", after: "Spring offer" },
      { item: "Sending with", before: "", after: "Mailchimp" },
      { item: "List", before: "", after: "Newsletter" },
      { item: "People", before: "", after: "412" },
    ];
    const card = cp({ channelSlug: "email_campaign", action_type: "send_message", executable: true, rows });
    expect(card).toMatchObject({ card_kind: "executes", primary_label: "Send to 412 people", done_label: "Done", owner: "zavi" });
    expect(card.how_to.join(" ")).toContain("Zavi creates the email in Mailchimp and sends it to that list");
    expect(card.how_to.join(" ")).not.toContain("makes the change");
    expect(cp({ channelSlug: "email_campaign", action_type: "send_message", executable: true, rows: [{ item: "People", before: "", after: "1" }] }).primary_label).toBe("Send to 1 person");
    expect(cp({ channelSlug: "email_campaign", action_type: "send_message", executable: true, rows: [] }).primary_label).toBe("Send email");
  });

  it("executes (SEO pull request): the button opens a PR, and the founder merges", () => {
    const card = cp({ channelSlug: "seo", action_type: "fix", executable: true });
    expect(card).toMatchObject({ card_kind: "executes", primary_label: "Open pull request", done_label: "Done" });
    expect(card.how_to.join(" ")).toContain("Nothing goes live until you do");
    expect(card.how_to.join(" ")).not.toContain("makes the change");
    expect(cp({ channelSlug: "seo", action_type: "fix" }).primary_label).not.toBe("Open pull request");
  });

  it("no email tool connected: the email stays a draft the founder copies and sends", () => {
    const card = cp({ channelSlug: "email_marketing", action_type: "send_message", deliverableKind: "email" });
    expect(card).toMatchObject({ card_kind: "message", primary_label: "Copy email", done_label: "I sent it", owner: "founder" });
    expect(card.how_to.join(" ")).toContain("Paste the email, pick who gets it, then send or schedule it.");
  });

  it("post (organic social with a composer)", () => {
    expect(cp({ channelSlug: "x_organic", action_type: "text_post", deliverableKind: "post" })).toMatchObject({
      card_kind: "post",
      primary_label: "Post on X",
      done_label: "I posted it",
    });
    expect(cp({ channelSlug: "linkedin_organic", action_type: "image_post" }).primary_label).toBe("Post on LinkedIn");
  });

  it("a reply has no composer on X or LinkedIn: it is copied", () => {
    expect(cp({ channelSlug: "x_organic", action_type: "reply" })).toMatchObject({
      card_kind: "copy_to_site",
      primary_label: "Copy post",
      done_label: "I posted it",
    });
  });

  it("reddit posts from the connected account, with or without a link on the card", () => {
    for (const link of ["https://www.reddit.com/r/x/comments/abc/t/", null]) {
      expect(cp({ channelSlug: "reddit_organic", action_type: "reply", link })).toMatchObject({
        card_kind: "post",
        primary_label: "Post on Reddit",
        done_label: "Posted",
      });
    }
  });

  it("post with no composer (Instagram, TikTok, YouTube, Pinterest): copied, posted from the app", () => {
    const ig = cp({ channelSlug: "instagram_organic", action_type: "image_post" });
    expect(ig).toMatchObject({ card_kind: "copy_to_site", primary_label: "Copy post", done_label: "I posted it" });
    expect(ig.how_to).toContain("Open the Instagram app and start a new post.");
  });

  it("plan is a strategy only; a brief or a list is content a task works from", () => {
    expect(cp({ channelSlug: "blog", action_type: "check", deliverableKind: "strategy" })).toMatchObject({
      card_kind: "plan",
      primary_label: "Approve plan",
      done_label: "Approved",
    });
    for (const kind of ["brief", "list"]) {
      const c = cp({ channelSlug: "ugc", action_type: "check", deliverableKind: kind });
      expect(c.primary_label, kind).not.toBe("Approve plan");
      expect(c.card_kind).toBe("task");
    }
  });

  it("a blog article (typed text_post) goes on the founder's site with the builder's steps", () => {
    const c = cp({ channelSlug: "blog", action_type: "text_post", deliverableKind: "article", siteBuilder: "webflow" });
    expect(c).toMatchObject({ card_kind: "copy_to_site", primary_label: "Copy post", done_label: "I put it on my site" });
    expect(c.how_to).toContain("In Webflow, open your blog's CMS collection and add a new item.");
  });

  it("listing copy for a profile on someone else's site is not an edit to the founder's page", () => {
    for (const channelSlug of ["geo", "seo", "blog"]) {
      const c = cp({ channelSlug, action_type: "fix", deliverableKind: "page_copy", targetKind: "profile", siteBuilder: "webflow" });
      expect(c).toMatchObject({ card_kind: "copy_to_site", primary_label: "Copy listing", done_label: "I created it" });
      expect(c.how_to.join(" ")).not.toMatch(/Webflow|your site|updated the page/);
    }
    const page = cp({ channelSlug: "geo", action_type: "fix", deliverableKind: "page_copy", targetKind: "page" });
    expect(page).toMatchObject({ primary_label: "Copy new text", done_label: "I updated the page" });
    const bio = cp({ channelSlug: "x_organic", action_type: "fix", deliverableKind: "page_copy", targetKind: "profile" });
    expect(bio.primary_label).toBe("Copy new text");
  });

  it("new profile text on a social channel is not website work", () => {
    const c = cp({ channelSlug: "x_organic", action_type: "fix", deliverableKind: "page_copy" });
    expect(c.primary_label).toBe("Copy new text");
    expect(c.how_to.join(" ")).not.toMatch(/WordPress|site's editor/);
    expect(c.how_to).toContain("Open X and find the text this card names.");
  });

  it("page copy on a channel that is neither (a UGC on-screen line) goes where the card says", () => {
    const c = cp({ channelSlug: "ugc", action_type: "fix", deliverableKind: "page_copy", siteBuilder: "wordpress" });
    expect(c.how_to.join(" ")).not.toMatch(/WordPress/);
    expect(c.how_to).toContain("Put the new text where this card says it goes.");
  });

  it("page copy on a non-profile channel (SMS opt-in, ad landing page) is website work", () => {
    for (const channelSlug of ["sms", "email_marketing", "meta_ads", "seo"]) {
      const c = cp({ channelSlug, action_type: "fix", deliverableKind: "page_copy", siteBuilder: "wordpress" });
      expect(c.how_to, channelSlug).toContain("In WordPress, open Pages and edit the page this card names.");
    }
  });

  it("nothing to copy or send: a task, never a Copy button (it would open on its done words)", () => {
    for (const [action_type, deliverableKind, channelSlug] of [
      ["send_message", null, "ugc"],
      ["send_message", "email", "ugc"],
      ["create_ad", "ad", "reddit_ads"],
      ["fix", "page_copy", "seo"],
      ["text_post", "post", "x_organic"],
      ["image_post", "post", "instagram_organic"],
    ] as const) {
      const c = cp({ channelSlug, action_type, deliverableKind, hasContent: false });
      expect(c.card_kind, `${channelSlug}/${action_type}`).toBe("task");
    }
  });

  it("message: one-to-one email opens mail, campaigns and DMs copy", () => {
    expect(cp({ channelSlug: "ugc", action_type: "send_message", deliverableKind: "email" })).toMatchObject({
      card_kind: "message",
      primary_label: "Open email",
      done_label: "I sent it",
    });
    expect(cp({ channelSlug: "email_marketing", action_type: "send_message", deliverableKind: "email" })).toMatchObject({
      card_kind: "message",
      primary_label: "Copy email",
    });
    expect(cp({ channelSlug: "ugc", action_type: "send_message", deliverableKind: "dm" }).primary_label).toBe("Copy message");
    expect(cp({ channelSlug: "sms", action_type: "other", deliverableKind: "sms" }).primary_label).toBe("Copy message");
  });

  it("ad built by hand (read-only ad channels)", () => {
    const c = cp({ channelSlug: "reddit_ads", action_type: "create_ad", deliverableKind: "ad" });
    expect(c).toMatchObject({ card_kind: "ad_manual", primary_label: "Copy ad", done_label: "I created it" });
    expect(c.how_to).toContain("In Reddit Ads › Campaigns › Create campaign, start a new ad.");
  });

  it("copy to your site: article, page copy, code", () => {
    expect(cp({ channelSlug: "blog", action_type: "page", deliverableKind: "article" })).toMatchObject({
      card_kind: "copy_to_site",
      primary_label: "Copy post",
      done_label: "I put it on my site",
    });
    expect(cp({ channelSlug: "seo", action_type: "fix", deliverableKind: "page_copy" })).toMatchObject({
      primary_label: "Copy new text",
      done_label: "I updated the page",
    });
    expect(cp({ channelSlug: "geo", action_type: "fix", deliverableKind: "code" }).primary_label).toBe("Copy code");
  });

  it("site steps follow the detected builder; unknown gets every builder's hint", () => {
    const wp = cp({ channelSlug: "blog", action_type: "page", deliverableKind: "article", siteBuilder: "wordpress" });
    expect(wp.how_to).toContain("In WordPress, go to Posts › Add New.");
    const unknown = cp({ channelSlug: "blog", action_type: "page", deliverableKind: "article" });
    expect(unknown.how_to.join(" ")).toMatch(/WordPress.*Webflow.*Shopify/);
    expect(unknown.how_to).toContain("Coded site? Send it to your developer instead.");
    const zavi = cp({ channelSlug: "blog", action_type: "page", deliverableKind: "article", siteBuilder: "zavi" });
    expect(zavi.how_to.join(" ")).toMatch(/built with Zavi/);
  });

  it("task: Open when the card has a link, else words from its role; the run's own list lines are the steps", () => {
    const withSteps = cp({
      channelSlug: "seo",
      action_type: "check",
      stepBody: "Why it matters.\n\n1. Open **Search Console**.\n2. Submit `sitemap.xml`.\n- Check coverage\n- tool_call_name",
    });
    expect(withSteps).toMatchObject({ card_kind: "task", primary_label: "Review it", done_label: "I reviewed it" });
    expect(withSteps.how_to).toEqual(["Open Search Console.", "Submit sitemap.xml.", "Check coverage"]);
    expect(cp({ channelSlug: "reddit_organic", action_type: "check", link: "https://www.reddit.com/r/x/" }).primary_label).toBe(
      "Open Reddit",
    );
    expect(cp({ channelSlug: "seo", action_type: "setup" }).how_to).toEqual([]);
  });

  it("task with no steps from the model or the run shows none, not a generic line", () => {
    const kit = { channelSlug: "geo", action_type: "check", deliverableKind: "list", hasContent: true } as const;
    expect(cp(kit).how_to).toEqual([]);
    expect(cp({ ...kit, structuredSteps: ["Open ChatGPT with search on, in a private window."] }).how_to).toEqual([
      "Open ChatGPT with search on, in a private window.",
    ]);
    expect(cp({ ...kit, stepBody: "1. Do a thing" }).how_to).toEqual(["Do a thing"]);
  });

  it("an unknown channel from a newer writer still gets words", () => {
    expect(cp({ channelSlug: "mastodon_organic", action_type: "text_post" }).primary_label).toBe("Copy post");
  });
});

describe("invariants over every combination", () => {
  const slugs = CHANNELS.map((c) => c.slug);
  const kinds = [null, ...DELIVERABLE_KINDS];

  it("no main button is ever past tense, every card has steps, every value fits the columns", () => {
    let n = 0;
    for (const channelSlug of slugs)
      for (const action_type of ACTION_TYPES)
        for (const deliverableKind of kinds)
          for (const executable of [false, true])
            for (const hasContent of [false, true])
            for (const link of [null, "https://www.reddit.com/r/x/"]) {
              const c = cp({ channelSlug, action_type, deliverableKind, executable, link, hasContent, stepBody: "1. Do a thing" });
              if (!hasContent) expect(["executes", "plan", "task"], `${channelSlug}/${action_type}/${deliverableKind}`).toContain(c.card_kind);
              n++;
              expect(CARD_KINDS).toContain(c.card_kind);
              expect(DONE_WORDS.some((w) => c.primary_label.startsWith(w)), `${channelSlug}/${action_type}/${deliverableKind}: ${c.primary_label}`).toBe(false);
              expect(c.primary_label.length).toBeGreaterThan(0);
              expect(c.primary_label.length).toBeLessThanOrEqual(60);
              expect(c.done_label.length).toBeLessThanOrEqual(60);
              expect(c.how_to.length).toBeGreaterThan(0);
              expect(c.how_to.length).toBeLessThanOrEqual(12);
              for (const s of c.how_to) expect(s.length).toBeLessThanOrEqual(200);
            }
    expect(n).toBeGreaterThan(1000);
  });

  it("executable always wins", () => {
    for (const channelSlug of slugs)
      for (const action_type of ACTION_TYPES)
        for (const deliverableKind of kinds)
          expect(cp({ channelSlug, action_type, deliverableKind, executable: true }).card_kind).toBe("executes");
  });

  it("the destination table covers every registered channel", () => {
    expect(Object.keys(DESTINATIONS).sort()).toEqual([...slugs].sort());
  });

  it("every site builder produces steps", () => {
    for (const siteBuilder of SITE_BUILDERS)
      for (const deliverableKind of ["article", "page_copy", "code"])
        expect(cp({ channelSlug: "blog", action_type: "page", deliverableKind, siteBuilder }).how_to.length).toBeGreaterThan(2);
  });
});

describe("listLines", () => {
  it("keeps list items, strips markdown, drops identifiers, caps at 8", () => {
    expect(listLines(null)).toEqual([]);
    expect(listLines("para only")).toEqual([]);
    expect(listLines("1) One\n2) [Two](https://x.y)\n* Three")).toEqual(["One", "Two", "Three"]);
    expect(listLines(Array.from({ length: 12 }, (_, i) => `- step ${i}`).join("\n"))).toHaveLength(8);
  });
});

describe("cardRole: tables, never the channel", () => {
  const role = (o: Partial<Parameters<typeof cardRole>[0]>) =>
    cardRole({ action_type: "other", executable: false, deliverableKind: null, siteBuilder: "unknown", ...o });

  it("Table A covers all 13 action types", () => {
    const want: Record<string, string> = {
      text_post: "create", image_post: "create", video_post: "create", reply: "create", page: "create", create_ad: "create",
      send_message: "reach_out", update_ad: "improve", pause_ad: "improve", fix: "improve", setup: "fix_setup", check: "review", other: "review",
    };
    expect(Object.keys(want).sort()).toEqual([...ACTION_TYPES].sort());
    for (const t of ACTION_TYPES) expect(role({ action_type: t }).intent, t).toBe(want[t]);
  });

  it("Table B: the model's intent wins; setup targets make repair work fix_setup; a plan is review", () => {
    expect(role({ action_type: "fix", stepIntent: "create", targetKind: "tracking" }).intent).toBe("create");
    expect(role({ action_type: "check", targetKind: "tracking" }).intent).toBe("fix_setup");
    expect(role({ action_type: "fix", targetKind: "account" }).intent).toBe("fix_setup");
    expect(role({ action_type: "text_post", targetKind: "account" }).intent).toBe("create");
    expect(role({ action_type: "text_post", deliverableKind: "strategy" }).intent).toBe("review");
  });

  it("Table C: executable is zavi, then the model's owner, then code off a Zavi site is the developer's", () => {
    expect(role({ executable: true, stepOwner: "developer" }).owner).toBe("zavi");
    expect(role({ stepOwner: "developer" }).owner).toBe("developer");
    expect(role({ deliverableKind: "code" }).owner).toBe("developer");
    expect(role({ deliverableKind: "code", siteBuilder: "zavi" }).owner).toBe("zavi");
    expect(role({}).owner).toBe("founder");
  });

  it("Table C: on a Zavi-built site the developer's work is Zavi's builder's, whatever the model said", () => {
    for (const siteBuilder of SITE_BUILDERS) {
      const want = siteBuilder === "zavi" ? "zavi" : "developer";
      expect(role({ stepOwner: "developer", siteBuilder }).owner, siteBuilder).toBe(want);
      expect(role({ stepOwner: "developer", deliverableKind: "code", siteBuilder }).owner, siteBuilder).toBe(want);
      expect(role({ stepOwner: "founder", siteBuilder }).owner, siteBuilder).toBe("founder");
    }
  });
});

describe("task words (Table D, E)", () => {
  it("tracking + check reads Verify / It works", () => {
    expect(cp({ action_type: "check", hasContent: false, targetKind: "tracking" })).toMatchObject({
      card_kind: "task", primary_label: "Verify", done_label: "It works", intent: "fix_setup",
    });
  });

  it("a link beats the intent for the main button; the done words still follow the intent", () => {
    expect(
      cp({ channelSlug: "reddit_organic", action_type: "check", hasContent: false, targetKind: "tracking", link: "https://www.reddit.com/r/x/" }),
    ).toMatchObject({ primary_label: "Open Reddit", done_label: "It works" });
  });

  it("on a Zavi-built site the developer's card is Send to Zavi, link or not, and no card on it reads Send to dev", () => {
    expect(
      cp({ channelSlug: "reddit_organic", action_type: "fix", hasContent: false, stepOwner: "developer", link: "https://www.reddit.com/r/x/", siteBuilder: "zavi" }),
    ).toMatchObject({ card_kind: "task", primary_label: "Send to Zavi", done_label: "I sent it to Zavi", owner: "zavi" });
    for (const deliverableKind of [null, "code", "page_copy", "article"])
      for (const stepOwner of [null, "founder", "developer"] as const) {
        const c = cp({ channelSlug: "seo", action_type: "fix", deliverableKind, stepOwner, siteBuilder: "zavi", structuredSteps: ["Ask your developer to edit the template."] });
        if (deliverableKind === null && stepOwner !== "developer") continue;
        expect(c, `${deliverableKind}/${stepOwner}`).toMatchObject({ card_kind: "task", primary_label: "Send to Zavi", owner: "zavi" });
        expect(c.how_to.join(" ")).not.toMatch(/developer/i);
      }
  });

  it("the developer beats the link", () => {
    expect(
      cp({ channelSlug: "reddit_organic", action_type: "fix", hasContent: false, stepOwner: "developer", link: "https://www.reddit.com/r/x/" }),
    ).toMatchObject({ primary_label: "Send to dev", done_label: "I sent it to dev", owner: "developer" });
  });

  it("the target names the thing: campaign + create_ad reads Create campaign; no noun falls back", () => {
    expect(cp({ channelSlug: "google_ads", action_type: "create_ad", hasContent: false, targetKind: "campaign" })).toMatchObject({
      card_kind: "task", primary_label: "Create campaign", done_label: "I created it",
    });
    expect(cp({ action_type: "fix", hasContent: false, targetKind: "person" }).primary_label).toBe("Apply change");
    expect(cp({ action_type: "setup", hasContent: false }).primary_label).toBe("Fix setup");
    expect(cp({ action_type: "send_message", hasContent: false }).primary_label).toBe("Reach out");
    expect(cp({ action_type: "update_ad", hasContent: false, targetKind: "ad_set" }).primary_label).toBe("Update ad set");
  });

  it("other card kinds keep today's words", () => {
    expect(cp({ channelSlug: "x_organic", action_type: "text_post", deliverableKind: "post", stepOwner: "developer" }).primary_label).toBe(
      "Post on X",
    );
  });
});

describe("structured steps (step.how_to)", () => {
  const how = ["Open the tag manager.", "No em dashes anywhere.", "Keep it within the limits.", "Publish the container."];

  it("replace the template and the body's list lines on a task", () => {
    const c = cp({ action_type: "setup", hasContent: false, stepBody: "1. From the body", structuredSteps: how });
    expect(c.how_to).toEqual(["Open the tag manager.", "Publish the container."]);
  });

  const checkLast = ["Open the tag manager.", "Check the preview."];

  it("on a copy card keep the template's Press line and come-back line around the model's steps", () => {
    const c = cp({ channelSlug: "blog", action_type: "page", deliverableKind: "article", siteBuilder: "wordpress", structuredSteps: checkLast, stepBody: "1. From the body" });
    expect(c.how_to).toEqual(["Press Copy post.", "Open the tag manager.", "Check the preview.", "Come back and press I put it on my site."]);
  });

  it("a message and a manual ad keep their closing done line too", () => {
    const msg = cp({ channelSlug: "x_organic", action_type: "send_message", structuredSteps: checkLast });
    expect(msg.how_to).toEqual(["Press Copy message.", "Open the tag manager.", "Check the preview.", "Send it, then press I sent it."]);
    const ad = cp({ channelSlug: "meta_ads", action_type: "create_ad", structuredSteps: checkLast });
    expect(ad.how_to[ad.how_to.length - 1]).toBe("Publish it, then press I created it.");
  });

  it("a message whose own last step sends it ends with ONE send: the closing line takes that step's place", () => {
    const msg = cp({ channelSlug: "x_organic", action_type: "send_message", structuredSteps: ["Open the thread.", "Send the message."] });
    expect(msg.how_to).toEqual(["Press Copy message.", "Open the thread.", "Send it, then press I sent it."]);
  });

  it("a manual ad whose own last step publishes it ends with ONE publish", () => {
    const ad = cp({ channelSlug: "meta_ads", action_type: "create_ad", structuredSteps: ["Open Ads Manager.", "Publish it."] });
    expect(ad.how_to).toEqual(["Press Copy ad.", "Open Ads Manager.", "Publish it, then press I created it."]);
  });

  it("a copy card keeps its own publish step when the closing line only records completion", () => {
    const c = cp({ channelSlug: "blog", action_type: "page", deliverableKind: "article", siteBuilder: "wordpress", structuredSteps: how, stepBody: "1. From the body" });
    expect(c.how_to).toEqual(["Press Copy post.", "Open the tag manager.", "Publish the container.", "Come back and press I put it on my site."]);
    const post = cp({ channelSlug: "blog", action_type: "page", deliverableKind: "article", siteBuilder: "wordpress", structuredSteps: ["Open WordPress.", "Publish the post."], stepBody: "1. From the body" });
    expect(post.how_to).toEqual(["Press Copy post.", "Open WordPress.", "Publish the post.", "Come back and press I put it on my site."]);
  });

  it("never on an executes card", () => {
    const c = cp({ channelSlug: "google_ads", action_type: "pause_ad", executable: true, structuredSteps: how });
    expect(c.how_to[0]).toBe("Check the exact change on this card.");
    expect(c.how_to).not.toContain("Open the tag manager.");
  });

  it("internal writing rules are dropped from the body's list lines too", () => {
    expect(listLines("- No em-dashes\n- Stay within limits\n- Check the character count\n- Post it")).toEqual(["Post it"]);
  });
});

describe("nameCrossRefs", () => {
  const titles = ["Install the tag", "Check the tag", "Post the thread"];
  it("names a card by its title", () => {
    expect(nameCrossRefs("Do this after action 1.", titles)).toBe('Do this after "Install the tag".');
    expect(nameCrossRefs("See card #3 and step 2 above.", titles)).toBe('See "Post the thread" and "Check the tag".');
    expect(nameCrossRefs("Recommendation 2 first.", titles)).toBe('"Check the tag" first.');
  });
  it("an out-of-range number drops its parenthetical, and is otherwise left alone", () => {
    expect(nameCrossRefs("Ship it (see action 7) today.", titles)).toBe("Ship it today.");
    expect(nameCrossRefs("Then action 7.", titles)).toBe("Then action 7.");
  });
  it("leaves a plain step number and ordinary numbers alone", () => {
    expect(nameCrossRefs("In step 2, add 3 keywords.", titles)).toBe("In step 2, add 3 keywords.");
  });
});

describe("answer cards", () => {
  it("intent answer reads Reply / Sent, link or not, with the model's steps", () => {
    for (const link of [null, "https://www.instagram.com/p/x/"])
      expect(
        cp({ channelSlug: "instagram_organic", action_type: "check", hasContent: false, stepIntent: "answer", link, structuredSteps: ["Open the two posts.", "Send back the handles."] }),
      ).toMatchObject({ card_kind: "task", primary_label: "Reply", done_label: "Sent", intent: "answer", owner: "founder", how_to: ["Open the two posts.", "Send back the handles."] });
  });

  const asks = (title: string, body: string | null = null, hasContent = false) =>
    asksFounderForAnswer({ intent: "review", hasContent, title, body });

  it("the backstop catches a review card asking the founder to send a fact back", () => {
    expect(asks("Open two ExampleBrand-tagged posts and send back the handles")).toBe(true);
    expect(asks("Find your best LinkedIn followers", "Open Analytics and send back the top Job titles and Companies.")).toBe(true);
    expect(asks("Bring me the handle")).toBe(true);
    expect(asks("Paste the top three rows back")).toBe(true);
    expect(asks("Confirm which campaigns are Advantage+")).toBe(true);
    expect(asks("Ask whether hard bounces are suppressed")).toBe(true);
    expect(asks("Check your email settings", "Then let us know what you find.")).toBe(true);
  });

  it("the backstop reads the card's steps, never its deliverable", () => {
    expect(asksFounderForAnswer({ intent: "review", hasContent: false, title: "Open your list settings", body: null, howTo: ["Open Settings.", "Paste it back here."] })).toBe(true);
    expect(asks("Post this on X", "Reply with your city below", true)).toBe(false);
    expect(asks("Update your bio", "Confirm the bio is live after you paste it", true)).toBe(false);
  });

  it("the backstop leaves sends, replies and paste cards alone", () => {
    expect(asks("Send this DM after answering a question")).toBe(false);
    expect(asks("Reply to comments within an hour")).toBe(false);
    expect(asks("Send back the handles", null, true)).toBe(false);
    expect(asks("Let your audience know about the sale")).toBe(false);
    expect(asks("Confirm the bio is live")).toBe(false);
    expect(asks("Ask for a testimonial after the order ships")).toBe(false);
    expect(asksFounderForAnswer({ intent: "create", hasContent: false, title: "Tell me the price", body: null })).toBe(false);
  });
});

describe("a LinkedIn campaign draft is reviewed, never copied", () => {
  const draft = { channelSlug: "linkedin_ads", action_type: "create_ad", deliverableKind: "ad", presentationType: "campaign_draft" };

  it("its button opens the review and its words never claim the campaign exists", () => {
    const c = cp(draft);
    expect(c).toMatchObject({ card_kind: "task", primary_label: "Review and create", done_label: "Done" });
    expect(c.how_to).toEqual([
      "Press Review and create on this card.",
      "Pick the company post to promote, then confirm the audience, places, daily budget and bid.",
      "Approve creation. Zavi creates the campaign paused, and nothing spends until you launch it.",
    ]);
    expect(JSON.stringify(c)).not.toMatch(/Copy ad|I created it/);
  });

  it("the model's own steps keep the line that says nothing spends yet", () => {
    const c = cp({ ...draft, structuredSteps: ["Add your delivery cities under Locations"] });
    expect(c.how_to).toEqual(["Add your delivery cities under Locations", "Approve creation. Zavi creates the campaign paused, and nothing spends until you launch it."]);
  });

  it("an ad built by hand on LinkedIn or Reddit, and a ChatGPT draft, keep their words", () => {
    expect(cp({ ...draft, presentationType: undefined })).toMatchObject({ card_kind: "ad_manual", primary_label: "Copy ad", done_label: "I created it" });
    expect(cp({ ...draft, channelSlug: "reddit_ads", presentationType: undefined })).toMatchObject({ card_kind: "ad_manual", primary_label: "Copy ad" });
    expect(cp({ ...draft, channelSlug: "chatgpt_ads" })).toMatchObject({ card_kind: "task", primary_label: "Review and create", done_label: "Done" });
  });
});

describe("a check in the ad platform's manager is a task, never a reply", () => {
  const title = "Check the two finished campaigns for impressions and clicks in Campaign Manager";
  const check = { channelSlug: "linkedin_ads", action_type: "check", hasContent: false, title, stepBody: "Open Campaign Manager. Let us know what you see." };

  it("opens the manager and closes with Done, even when the model typed it an answer", () => {
    for (const stepIntent of [null, "answer"] as const) {
      const c = cp({ ...check, stepIntent });
      expect(c).toMatchObject({ card_kind: "task", primary_label: "Open Campaign Manager", done_label: "Done", intent: "review", owner: "founder" });
    }
  });

  it("the backstop does not turn it into an answer card", () => {
    expect(asksFounderForAnswer({ intent: "review", hasContent: false, title, body: "Let us know what you see." })).toBe(false);
  });

  it("still sends a real question back and names Ads Manager on other channels", () => {
    expect(cp({ ...check, title: "Tell me the handle you use", stepIntent: "answer" })).toMatchObject({ primary_label: "Reply", done_label: "Sent" });
    expect(cp({ ...check, channelSlug: "meta_ads", title: "Check the delivery status in Ads Manager" })).toMatchObject({ primary_label: "Open Ads Manager", done_label: "Done" });
  });
});

describe("geo's Check AI answers card presses Zavi's own check, never asks for hand work", () => {
  const check = { channelSlug: "geo", action_type: "other", deliverableKind: "list", presentationType: "answer_check" } as const;

  it("its button is the GEO page's check, and its steps say Zavi asks the assistants", () => {
    const c = cp(check);
    expect(c).toMatchObject({ card_kind: "task", primary_label: "Check AI answers", done_label: "Checking" });
    expect(c.how_to[0]).toBe("Press Check AI answers. Zavi asks the AI assistants the questions on this card.");
    expect(JSON.stringify(c)).not.toMatch(/ChatGPT|Perplexity|private window|paste/i);
  });

  it("the model's own steps (the hand-run kit) do not replace the fixed words", () => {
    expect(cp({ ...check, structuredSteps: ["Paste each into ChatGPT in a private window"] }).how_to).toHaveLength(3);
  });

  it("only geo, and never an executable card, gets it", () => {
    expect(cp({ ...check, channelSlug: "seo" }).primary_label).not.toBe("Check AI answers");
    expect(cp({ ...check, executable: true }).primary_label).not.toBe("Check AI answers");
  });
});

describe("LinkedIn Ads: an audience list is a review card with fixed steps", () => {
  const SHEET = [
    "AUDIENCE 1: operations leads at mid-size companies",
    "Locations:      United States (Zavi's suggestion)",
    "Company size:   51-200, 201-500",
    "Audience Expansion: OFF    LinkedIn Audience Network: OFF",
    "",
    "AUDIENCE 2: people who visited your site",
    "Source:        Website visitors, from the Insight Tag",
    "Window:        90 days (Zavi's suggestion)",
  ].join("\n");
  const clickPath = [
    "In Campaign Manager open Plan > Audiences > Create, set facets, Save.",
    "Press Open Campaign Manager and save both audiences.",
  ];
  const audience: Partial<CardPresentationInput> = {
    channelSlug: "linkedin_ads",
    action_type: "check",
    deliverableKind: "list",
    hasContent: true,
    deliverableContent: SHEET,
    stepBody: "1. Go to Plan > Audiences > Create\n2. Save",
    structuredSteps: clickPath,
    title: "Save two audiences in Campaign Manager for when the verdict flips",
  };
  const pressed = (steps: string[]) => steps.flatMap((s) => Array.from(s.matchAll(/\bPress ([^.]+)\./g), (m) => m[1]));

  it("must-catch: the model's click path never reaches the card, and every Press step names one of its two buttons", () => {
    for (const action_type of ["check", "other", "setup", "fix"]) {
      for (const stepIntent of [null, "answer", "create"] as const) {
        const c = cp({ ...audience, action_type, stepIntent });
        expect(c).toMatchObject({ card_kind: "task", primary_label: "Create audience", done_label: "Done", intent: "review" });
        expect(c.how_to).toEqual([...AUDIENCE_REVIEW_STEPS]);
        const all = c.how_to.join("\n");
        expect(all).not.toMatch(/Plan >|Campaign Manager|Open |save both/i);
        expect(pressed(c.how_to).length).toBeGreaterThan(0);
        for (const name of pressed(c.how_to)) expect([c.primary_label, c.done_label]).toContain(name);
      }
    }
  });

  it("must-catch: the stored row re-derives to the same review card", () => {
    const p = backfillPresentation(
      { id: "a", tenant_id: "t", channel_slug: "linkedin_ads", action_type: "check", exec_class: null, body: { step: { title: "t", body: "b", how_to: clickPath, deliverable: { kind: "list", content: SHEET } } } },
      "unknown",
    );
    expect(p).toMatchObject({ card_kind: "task", primary_label: "Create audience", done_label: "Done" });
    expect(p.how_to).toEqual([...AUDIENCE_REVIEW_STEPS]);
  });

  it("another channel's audience list keeps the model's own steps and words", () => {
    for (const channelSlug of ["meta_ads", "reddit_ads", "google_ads"]) {
      const c = cp({ ...audience, channelSlug });
      expect(c.how_to).toEqual(clickPath);
      expect(c.primary_label).not.toBe("I reviewed it");
      expect(c).toEqual(cp({ ...audience, channelSlug, deliverableContent: null }));
    }
  });

  it("a LinkedIn executable card, a campaign draft and a task with no audience list are unchanged", () => {
    const exec = cp({ ...audience, action_type: "pause_ad", executable: true });
    expect(exec).toMatchObject({ card_kind: "executes", primary_label: "Pause" });
    expect(exec).toEqual(cp({ ...audience, action_type: "pause_ad", executable: true, deliverableContent: null }));
    const prose = "Audience notes.\nLocations: anywhere";
    const task = cp({ ...audience, deliverableContent: prose });
    expect(task.how_to).toEqual(clickPath);
    expect(task).toEqual(cp({ ...audience, deliverableContent: null }));
    expect(cp({ ...audience, deliverableContent: "AUDIENCE 1: one line only\nno pairs" }).how_to).toEqual(clickPath);
    for (const deliverableKind of ["list", "ad", "brief"]) {
      const draft = cp({ ...audience, action_type: "create_ad", deliverableKind, presentationType: "campaign_draft" });
      expect(draft).toMatchObject({ card_kind: "task", primary_label: "Review and create", done_label: "Done" });
      expect(draft.how_to.join(" ")).not.toContain("I reviewed it");
    }
    for (const deliverableKind of ["ad", "brief", "doc", "strategy"]) {
      const c = cp({ ...audience, action_type: "create_ad", deliverableKind });
      expect(c.primary_label).not.toBe("I reviewed it");
      expect(c).toEqual(cp({ ...audience, action_type: "create_ad", deliverableKind, deliverableContent: null }));
    }
  });
});
