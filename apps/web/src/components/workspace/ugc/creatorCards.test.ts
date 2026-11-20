import { describe, expect, it } from "vitest";
import { CREATOR_VIDEO_CHANNELS } from "@zavi/shared";
import type { HumanBrief } from "@/components/humans/humanTypes";
import type { CreatorJobSummary } from "@/components/humans/creatorJobTypes";
import {
  assetIsReady,
  orderFacts,
  sourcePage,
  cheapestFittingPackage,
  onePerKind,
  ugcHubCards,
  ugcHubNumbers,
  videoChannelCards,
  boostCreatorPostCard,
  postBriefCard,
  staticCreatorCards,
  getCreatorVideoCard,
  waitingCard,
  type LibraryAssetLite,
} from "./creatorCards";

const NOW = new Date("2026-09-27T12:00:00Z");

function brief(over: Partial<HumanBrief> = {}): HumanBrief {
  return {
    id: "b1",
    title: "Spring launch",
    utm_campaign: "zavi-brief-1",
    status: "draft",
    deliverables: 1,
    created_at: "2026-09-26T00:00:00Z",
    match_count: null,
    application_count: 0,
    engagement_count: 0,
    posted_at: null,
    answer_by: null,
    closed_at: null,
    angle: "A real morning routine",
    hook: "I did not expect this",
    format: "Vertical 9:16, 30 seconds",
    lane: "ugc_video",
    budget_usd: 150,
    delivery_days: 7,
    applicant_cap: 20,
    ad_rights_days: 90,
    source_channel: null,
    ...over,
  };
}

function job(over: Partial<CreatorJobSummary> = {}): CreatorJobSummary {
  return {
    id: "j1",
    source: "booking",
    status: "submitted",
    closed_reason: null,
    title: "1 video",
    creator_display_name: "Maya Films",
    creator_slug: "maya-films",
    created_at: "2026-09-20T00:00:00Z",
    due_at: null,
    money: {
      currency: "usd",
      price_cents: 15000,
      business_fee_cents: 1500,
      business_total_cents: 16500,
      business_fee_label: "Zavi fee",
      creator_payout_cents: 12750,
      payout_status: "not_due",
    },
    deadline: { kind: "review", deadline_at: "2026-09-30T16:40:00Z" } as CreatorJobSummary["deadline"],
    awaiting_creator: false,
    revisions_used: 0,
    ...over,
  };
}

function asset(over: Partial<LibraryAssetLite> = {}): LibraryAssetLite {
  return {
    id: "a1",
    created_at: "2026-09-25T00:00:00Z",
    rights_start_at: "2026-09-25T00:00:00Z",
    rights_end_at: "2026-12-24T00:00:00Z",
    rights_expired: false,
    meta: null,
    youtube: null,
    creator_display_name: "Maya Films",
    source_channel: "meta_ads",
    ...over,
  };
}

describe("UGC Overview: the five hiring cards, ranked", () => {
  it("orders review, use, post, applicants; no Book card while a job is open", () => {
    const cards = ugcHubCards(
      {
        briefs: [
          brief({ id: "draft" }),
          brief({ id: "posted", status: "sent", posted_at: "2026-09-26T00:00:00Z", application_count: 3, answer_by: "2026-10-01T00:00:00Z" }),
        ],
        jobs: [job()],
        library: [asset()],
        bookable: 2,
      },
      NOW,
    );
    expect(cards.map((c) => c.title)).toEqual([
      "Maya delivered: review it",
      "Use Maya's video in Meta Ads",
      "Post this brief to Zavi creators: Spring launch",
      "3 creators applied to Spring launch: pick one",
    ]);
    expect(cards[0].primary.label).toBe("Approve and release $150");
    expect(cards[0].secondary?.[0].label).toBe("Request a change (round 1 of 2)");
    expect(cards[1].secondary?.[0].target).toEqual({ kind: "channel", slug: "meta_ads" });
    expect(cards[2].primary).toEqual({ label: "Review and post", target: { kind: "drawer", name: "brief", params: { brief: "draft" } } });
    expect(cards[2].secondary).toBeUndefined();
    expect(cards[3].primary.target).toEqual({ kind: "drawer", name: "applicants", params: { brief: "posted" } });
  });

  it("offers Book directly with no open job, and again once every job has closed", () => {
    const titles = (jobs: CreatorJobSummary[]) => ugcHubCards({ briefs: [brief()], jobs, library: [], bookable: 2 }, NOW).map((c) => c.title);
    expect(titles([])).toContain("Or book a creator directly");
    expect(titles([job({ status: "awaiting_acceptance" })])).not.toContain("Or book a creator directly");
    expect(titles([job({ status: "in_progress" })])).not.toContain("Or book a creator directly");
    expect(titles([job({ status: "completed", closed_reason: "approved" })])).toContain("Or book a creator directly");
    const book = ugcHubCards({ briefs: [brief()], jobs: [], library: [], bookable: 2 }, NOW).find((c) => c.kind === "Book");
    expect(book?.primary.target).toEqual({ kind: "drawer", name: "find" });
  });

  it("shows no card before the first brief or job, so the empty lane keeps its Run button", () => {
    expect(ugcHubCards({ briefs: [], jobs: [], library: [], bookable: 12 }, NOW)).toEqual([]);
    const afterRun = ugcHubCards({ briefs: [brief({ id: "from-run" })], jobs: [], library: [], bookable: 12 }, NOW).map((c) => c.kind);
    expect(afterRun).toEqual(["Brief", "Book"]);
    const closedJob = ugcHubCards({ briefs: [], jobs: [job({ status: "completed", closed_reason: "approved" })], library: [], bookable: 12 }, NOW);
    expect(closedJob.map((c) => c.kind)).toContain("Book");
  });

  it("clears a draft brief only when a job names it", () => {
    const drafts = (jobs: CreatorJobSummary[]) =>
      ugcHubCards({ briefs: [brief({ id: "draft" })], jobs, library: [], bookable: 0 }, NOW).filter((c) => c.kind === "Brief");
    expect(drafts([job({ status: "in_progress", brief_id: null })])).toHaveLength(1);
    expect(drafts([job({ status: "in_progress", brief_id: "other" })])).toHaveLength(1);
    expect(drafts([job({ status: "in_progress", brief_id: "draft" })])).toHaveLength(0);
    expect(drafts([job({ status: "cancelled", closed_reason: "declined", brief_id: "draft" })])).toHaveLength(1);
  });

  it("the applicants card says both ways the brief closes", () => {
    const [card] = ugcHubCards(
      { briefs: [brief({ status: "sent", posted_at: "2026-09-26T00:00:00Z", application_count: 2, answer_by: "2026-10-02T23:59:59.000Z" })], jobs: [], library: [], bookable: 0 },
      NOW,
    );
    expect(card.lead).toBe("Answer everyone by Oct 2. The brief closes on that date, or sooner when you pay to hire someone.");
  });

  it("a brief the founder started from a channel does not say Zavi wrote it", () => {
    const facts = { business_name: "Sample Co", evidence: [], rationale: "Written by hand. No agent argued for this brief." };
    const [mine] = ugcHubCards({ briefs: [brief({ source_channel: "meta_ads" })], jobs: [], library: [], bookable: 0, briefFacts: { b1: facts } }, NOW);
    expect(mine.lead).toMatch(/^You started this brief from Meta Ads\./);
    const [agent] = ugcHubCards(
      { briefs: [brief({ source_channel: "meta_ads" })], jobs: [], library: [], bookable: 0, briefFacts: { b1: { ...facts, rationale: "Agent argument" } } },
      NOW,
    );
    expect(agent.lead).toMatch(/^Zavi wrote the brief for Meta Ads\./);
  });

  it("names no author when the brief's details did not load", () => {
    const [plain] = ugcHubCards({ briefs: [brief()], jobs: [], library: [], bookable: 0 }, NOW);
    expect(plain.lead).toBe("This brief is ready to post. Review it, then post it to creators on Zavi who match it.");
    const [channel] = ugcHubCards({ briefs: [brief({ source_channel: "meta_ads" })], jobs: [], library: [], bookable: 0 }, NOW);
    expect(channel.lead).toMatch(/^This brief is for Meta Ads\./);
  });

  it("shows no book card when nobody is bookable (the run writes the DM card then)", () => {
    const cards = ugcHubCards({ briefs: [], jobs: [], library: [], bookable: 0 }, NOW);
    expect(cards).toEqual([]);
  });

  it("offers no third change round", () => {
    const [card] = ugcHubCards({ briefs: [], jobs: [job({ revisions_used: 2 })], library: [], bookable: 0 }, NOW);
    expect(card.secondary).toEqual([]);
    expect(card.why).toContain("Both change rounds are used. Approve it, or ask Zavi for help.");
  });

  it("skips closed briefs, briefs nobody applied to, and jobs that are done or cancelled", () => {
    const cards = ugcHubCards(
      {
        briefs: [
          brief({ closed_at: "2026-09-26T00:00:00Z" }),
          brief({ id: "quiet", status: "sent", posted_at: "2026-09-26T00:00:00Z", application_count: 0 }),
        ],
        jobs: [job({ status: "completed" }), job({ id: "j2", status: "cancelled" })],
        library: [],
        bookable: 0,
      },
      NOW,
    );
    expect(cards).toEqual([]);
  });

  it("hands over the file for a video no channel asked for", () => {
    const [card] = ugcHubCards({ briefs: [], jobs: [], library: [asset({ source_channel: null })], bookable: 0 }, NOW);
    expect(card.title).toBe("Use Maya's video in your ads");
    expect(card.secondary?.[0].target).toEqual({ kind: "download", assetId: "a1" });
  });
});

describe("the details the wireframe shows, from real rows only", () => {
  const order = orderFacts({
    package_snapshot: { video_count: 1, platform: "TikTok", video_length_seconds: 30, ad_rights_days: 90, booked_from: "package" },
    submissions: [
      { version: 1, kind: "video", created_at: "2026-09-28T10:00:00Z", play_url: "https://x/v1" },
      { version: 2, kind: "video", created_at: "2026-10-01T16:40:00Z", play_url: "https://x/v2" },
      { version: 2, kind: "raw_footage", created_at: "2026-10-01T16:40:00Z", play_url: null },
    ],
  });

  it("names what was delivered, when, and plays the latest cut", () => {
    const [card] = ugcHubCards({ briefs: [], jobs: [job()], library: [], bookable: 0, orders: { j1: order } }, NOW);
    expect(card.title).toBe("Maya delivered 1 TikTok video: review it");
    expect(card.lead).toBe("Delivered Oct 1, 16:40 UTC. If you don't answer by Sep 30, 16:40 UTC, the job closes as accepted.");
    expect(card.why[0]).toBe("30 seconds, with ad rights for 90 days from the package.");
    expect(card.media).toMatchObject({ caption: "30s video", url: "https://x/v2" });
  });

  it("a review card before payment says the video is a watermarked preview, or that it is being prepared", () => {
    const facts = (over: { play_url: string | null; watermarked: boolean; preview: "ready" | "preparing" | "failed" | null }) =>
      orderFacts({
        package_snapshot: { video_count: 1, platform: "TikTok", video_length_seconds: 30, ad_rights_days: 90, booked_from: "package" },
        submissions: [{ version: 1, kind: "video", created_at: "2026-10-01T16:40:00Z", ...over }],
      });
    const line = /watermarked preview\. The original unlocks to download and post once you approve and pay/;

    const [ready] = ugcHubCards({ briefs: [], jobs: [job()], library: [], bookable: 0, orders: { j1: facts({ play_url: "https://x/p", watermarked: true, preview: "ready" }) } }, NOW);
    expect(ready.media).toMatchObject({ caption: "30s video · watermarked preview", url: "https://x/p", watermarked: true, waiting: false });
    expect(ready.why.some((w) => line.test(w))).toBe(true);

    const [making] = ugcHubCards({ briefs: [], jobs: [job()], library: [], bookable: 0, orders: { j1: facts({ play_url: null, watermarked: false, preview: "preparing" }) } }, NOW);
    expect(making.media).toMatchObject({ caption: "Preview being prepared", url: null, watermarked: false, waiting: true });
    expect(making.why.some((w) => line.test(w))).toBe(true);

    const [plain] = ugcHubCards({ briefs: [], jobs: [job()], library: [], bookable: 0, orders: { j1: order } }, NOW);
    expect(plain.why.some((w) => line.test(w))).toBe(false);
  });

  it("without the job's detail, the title claims no count", () => {
    const [card] = ugcHubCards({ briefs: [], jobs: [job()], library: [], bookable: 0 }, NOW);
    expect(card.title).toBe("Maya delivered: review it");
  });

  it("says which page the brief came from, and uses the evidence as the reasons", () => {
    const facts = {
      business_name: "Sample Co",
      evidence: [
        { claim: "The spring page leads with the oat latte", source: "web_fetch https://www.example.com/spring/" },
        { claim: "Creators here film morning routines", source: "apify__scrape_tiktok" },
      ],
      rationale: "Agent argument",
    };
    expect(sourcePage(facts.evidence)).toBe("example.com/spring");
    const [card] = ugcHubCards({ briefs: [brief()], jobs: [], library: [], bookable: 0, briefFacts: { b1: facts } }, NOW);
    expect(card.lead).toBe("Zavi wrote the brief from your page example.com/spring. Review it, then post it to creators on Zavi who match it.");
    expect(card.why).toEqual(["The spring page leads with the oat latte", "Creators here film morning routines"]);
    expect(card.preview).toEqual({ business: "Sample Co", title: "Spring launch", angle: "A real morning routine", hook: "I did not expect this" });
    expect(card.pane?.rows.map(([k]) => k)).not.toContain("Where");
  });

  it("the Meta ad rows the library cannot fill yet say when they get filled", () => {
    const [, ready] = videoChannelCards("meta_ads", { briefs: [], library: [asset({ order_id: "o1" })], budget: null, orders: { o1: order } }, NOW);
    const rows = Object.fromEntries(ready.pane!.rows);
    expect(rows.Starts).toBe("Paused");
    expect(ready.pane!.muted).toContain(rows.Campaign);
    expect(ready.pane!.muted).toContain(rows.Headline);
    expect(ready.why).toEqual(["Ad rights: 90 days, from Maya Films's package."]);
    expect(ready.media?.url).toBe("https://x/v2");
  });
});

describe("the six video channels", () => {
  it("every video channel offers the prefilled brief, opening UGC's brief drawer", () => {
    for (const slug of CREATOR_VIDEO_CHANNELS) {
      const [card] = videoChannelCards(slug, { briefs: [], library: [], budget: null }, NOW);
      expect(card.title).toMatch(/^Create a video brief for /);
      expect(card.primary.label).toBe("Create video brief");
      expect(card.dismiss).toBe("Not now");
      expect(card.dismissForDays).toBe(14);
      expect(card.pane?.rows).toEqual(
        expect.arrayContaining([
          ["Format", "Vertical 9:16, 30 seconds"],
          ["Ad rights", "90 days"],
        ]),
      );
      expect(card.primary.target).toEqual({ kind: "channel", slug: "ugc", drawer: "brief", params: { from: slug } });
    }
  });

  it("quotes only a package that fits the brief, and no budget when none does", () => {
    const pkg = (id: string, price_cents: number, video_length_seconds: number, ad_rights_days: number, video_count = 1) => ({
      id, kind: "ugc_video", price_cents, video_length_seconds, ad_rights_days, video_count,
    });
    const short = pkg("short", 5000, 20, 30);
    const fits = pkg("fits", 15000, 30, 90);
    const longer = pkg("longer", 12000, 60, 365);
    const bundle = pkg("bundle", 33000, 30, 90, 3);
    expect(cheapestFittingPackage([short, fits])?.id).toBe("fits");
    expect(cheapestFittingPackage([short, fits, longer])?.id).toBe("longer");
    expect(cheapestFittingPackage([fits, bundle])?.id).toBe("bundle");
    expect(cheapestFittingPackage([short, pkg("no-rights", 9000, 30, 30)])).toBeNull();
    expect(cheapestFittingPackage([{ ...fits, kind: "audience_post" }])).toBeNull();

    const budget = { creator: "Maya Films", price_cents: 15000, package_title: "1 UGC video", video_count: 1 };
    const [card] = videoChannelCards("meta_ads", { briefs: [], library: [], budget }, NOW);
    expect(card.pane?.rows).toContainEqual(["Budget estimate", "Around $150 per video, plus 10% fee"]);
    const [none] = videoChannelCards("meta_ads", { briefs: [], library: [], budget: null }, NOW);
    expect(none.pane?.rows).toContainEqual(["Budget estimate", "Choose a budget in the brief"]);
  });

  it("drops the prefill while a posted brief for this channel is still open", () => {
    const posted = brief({ source_channel: "tiktok_ads", status: "posted", posted_at: "2026-09-26T10:00:00Z" });
    const cards = videoChannelCards("tiktok_ads", { briefs: [posted], library: [], budget: null }, NOW);
    expect(cards).toEqual([]);
  });

  it("an organic channel's brief says where the post goes, not an ad placement", () => {
    const [ig] = videoChannelCards("instagram_organic", { briefs: [], library: [], budget: null }, NOW);
    expect(ig.lead).toMatch(/^Explore a creator video to post on your Instagram Reels\. Open the UGC brief editor/);
    const [ad] = videoChannelCards("tiktok_ads", { briefs: [], library: [], budget: null }, NOW);
    expect(ad.lead).toMatch(/^Explore a creator video for this placement\. /);
  });

  it("a draft the founder rejected, or never posted, does not hide this channel's brief card", () => {
    const draft = brief({ id: "d1", source_channel: "tiktok_ads", status: "draft", posted_at: null });
    const [card, ...rest] = videoChannelCards("tiktok_ads", { briefs: [draft], library: [], budget: null }, NOW);
    expect(card.id).toBe("tiktok_ads-get-creator-video");
    expect(card.title).toMatch(/^Create a video brief for /);
    expect(rest).toEqual([]);

    const closed = brief({ id: "c1", source_channel: "tiktok_ads", status: "posted", posted_at: "2026-09-20T10:00:00Z", closed_at: "2026-09-25T10:00:00Z" });
    expect(videoChannelCards("tiktok_ads", { briefs: [draft, closed], library: [], budget: null }, NOW).map((c) => c.id)).toEqual(["tiktok_ads-get-creator-video"]);

    const live = brief({ id: "p1", source_channel: "tiktok_ads", status: "posted", posted_at: "2026-09-26T10:00:00Z" });
    expect(videoChannelCards("tiktok_ads", { briefs: [draft, live], library: [], budget: null }, NOW)).toEqual([]);
    const elsewhere = brief({ id: "p2", source_channel: "meta_ads", status: "posted", posted_at: "2026-09-26T10:00:00Z" });
    expect(videoChannelCards("tiktok_ads", { briefs: [draft, elsewhere], library: [], budget: null }, NOW).map((c) => c.id)).toEqual(["tiktok_ads-get-creator-video"]);
  });

  it("shows a ready video only on the channel that asked for it, with a push only where one exists", () => {
    const lib = [asset({ id: "m", source_channel: "meta_ads" }), asset({ id: "t", source_channel: "tiktok_organic" })];
    const meta = videoChannelCards("meta_ads", { briefs: [], library: lib, budget: null }, NOW);
    expect(meta.map((c) => c.title)).toEqual([expect.stringMatching(/^Create a video brief for /), "Maya's video is ready: run it as an ad"]);
    expect(meta[1].primary.target).toEqual({ kind: "push", assetId: "m", push: "meta" });

    const tiktok = videoChannelCards("tiktok_organic", { briefs: [], library: lib, budget: null }, NOW);
    expect(tiktok[1].title).toBe("Maya's video is ready: post it");
    expect(tiktok[1].primary.target).toEqual({ kind: "download", assetId: "t" });

    const tiktokAds = videoChannelCards("tiktok_ads", { briefs: [], library: [asset({ source_channel: "tiktok_ads" })], budget: null }, NOW);
    expect(tiktokAds[1].title).toBe("Maya's video is ready: run it as an ad");
    expect(tiktokAds[1].primary.target).toMatchObject({ kind: "download" });

    const yt = videoChannelCards("youtube_ads", { briefs: [], library: [asset({ source_channel: "youtube_ads" })], budget: null }, NOW);
    expect(yt[1].primary.target).toMatchObject({ kind: "push", push: "youtube" });
  });

  it("a video already in Meta, out of rights, or older than 30 days is not 'ready'", () => {
    expect(assetIsReady(asset(), NOW)).toBe(true);
    expect(assetIsReady(asset({ meta: { ad_id: "123" } }), NOW)).toBe(false);
    expect(assetIsReady(asset({ rights_expired: true }), NOW)).toBe(false);
    expect(assetIsReady(asset({ created_at: "2026-08-01T00:00:00Z" }), NOW)).toBe(false);
  });
});

describe("Next steps shows one card of each kind (wireframe /hire/channel)", () => {
  it("twenty drafts are one Post this brief card, and the rest wait behind Show more", () => {
    const drafts = Array.from({ length: 20 }, (_, i) => brief({ id: `d${i}` }));
    const cards = ugcHubCards({ briefs: drafts, jobs: [job()], library: [], bookable: 2 }, NOW);
    const { shown, rest } = onePerKind(cards);
    expect(shown.map((c) => c.kind)).toEqual(["Review", "Brief"]);
    expect(shown[1].id).toBe("ugc-post-brief-d0");
    expect(rest).toHaveLength(19);
    expect(rest.every((c) => c.kind === "Brief")).toBe(true);
  });
});

describe("the UGC numbers row, from the tenant's own briefs, jobs and library", () => {
  const facts = (n: number) => ({ package_snapshot: null, video: null, video_count: n });

  it("counts posted open briefs, paid creators, delivered videos and what the business paid", () => {
    const numbers = ugcHubNumbers({
      briefs: [
        brief({ id: "draft" }),
        brief({ id: "out", posted_at: "2026-09-22T00:00:00Z", status: "sent" }),
        brief({ id: "shut", posted_at: "2026-09-01T00:00:00Z", closed_at: "2026-09-10T00:00:00Z", status: "sent" }),
      ],
      jobs: [
        job({ id: "a", status: "submitted" }),
        job({ id: "b", status: "completed" }),
        job({ id: "c", status: "in_progress", creator_slug: "leo", creator_display_name: "Leo" }),
        job({ id: "d", status: "awaiting_acceptance", creator_slug: "ivy" }),
        job({ id: "e", status: "checkout_pending", creator_slug: "ivy" }),
        job({ id: "f", status: "cancelled", creator_slug: "bo" }),
      ],
      library: [asset({ id: "x", order_id: "b" })],
      orders: { a: facts(2), b: facts(3) },
    });
    expect(Object.fromEntries(numbers.map((m) => [m.key, m.value]))).toEqual({
      briefs_out: 1,
      creators_hired: 2,
      videos_delivered: 5,
      spent: 495,
    });
  });

  it("Spent is what the business paid minus a partial refund", () => {
    const spent = ugcHubNumbers({
      briefs: [],
      jobs: [
        job({ id: "a", status: "completed" }),
        job({ id: "b", status: "completed", closed_reason: "mediation_pay_part", refunded_cents: 10_000 }),
      ],
      library: [],
    }).find((m) => m.key === "spent");
    expect(spent).toEqual({ key: "spent", value: 230, unit: "usd" });
  });

  it("shows no number, never a guess, when a refund or a delivery could not be read", () => {
    const numbers = ugcHubNumbers({
      briefs: [],
      jobs: [job({ id: "a", status: "submitted" }), job({ id: "b", status: "completed", closed_reason: "mediation_pay_part", refunded_cents: null })],
      library: [],
      orders: {},
    });
    expect(numbers.find((m) => m.key === "spent")).toMatchObject({ value: null, unmeasured: expect.any(String) });
    expect(numbers.find((m) => m.key === "videos_delivered")).toMatchObject({ value: null, unmeasured: expect.any(String) });
  });
});

describe("the post-brief card's kind of job", () => {
  it("a UGC brief, or one with no lane, says UGC video", () => {
    for (const lane of ["ugc_video", null]) {
      const rows = postBriefCard(brief({ lane })).pane?.rows ?? [];
      expect(rows).toContainEqual(["Kind of job", "UGC video: you post it and run it as an ad"]);
    }
  });
  it("an old audience-post brief is never called a UGC video or a post on the creator's account", () => {
    const rows = postBriefCard(brief({ lane: "audience_post" })).pane?.rows ?? [];
    expect(rows.find(([k]) => k === "Kind of job")).toBeUndefined();
    expect(JSON.stringify(rows)).not.toMatch(/creator.s account|audience/i);
  });
});

describe("boost a creator's post (static how-to cards)", () => {
  it("shows on Meta Ads and TikTok Ads only", () => {
    expect(staticCreatorCards("meta_ads").map((c) => c.id)).toEqual(["meta_ads-boost-creator-post"]);
    expect(staticCreatorCards("tiktok_ads").map((c) => c.id)).toEqual(["tiktok_ads-boost-creator-post"]);
    for (const slug of ["ugc", "influencer", "google_ads", "youtube_ads", "instagram_organic", "seo"]) {
      expect(staticCreatorCards(slug)).toEqual([]);
    }
  });

  it("never claims Zavi creates the ad or keeps the code", () => {
    for (const slug of ["meta_ads", "tiktok_ads"] as const) {
      const c = boostCreatorPostCard(slug);
      expect(c.why.join(" ")).toMatch(/does not create this ad or keep the code/);
      expect(c.primary).toEqual({ label: "Done", target: { kind: "hide" } });
      expect(c.dismiss).toBe("Not now");
    }
  });

  it("names the right code per platform, and never claims TikTok results can't be reported", () => {
    expect(boostCreatorPostCard("meta_ads").pane?.note).toMatch(/partnership ad code/);
    expect(boostCreatorPostCard("tiktok_ads").pane?.note).toMatch(/Spark Ads code/);
    expect(boostCreatorPostCard("tiktok_ads").why.join(" ")).not.toMatch(/can't report|no TikTok ad connection/);
  });

  it("uses its own kind, so it never hides behind a video card of kind Ad", () => {
    expect(boostCreatorPostCard("meta_ads").kind).toBe("How to");
    expect(getCreatorVideoCard("meta_ads", null).kind).toBe("Brief");
  });

  it("a brief for a creator video is never tagged as an ad or post, and never hides a ready video", () => {
    for (const slug of CREATOR_VIDEO_CHANNELS) expect(getCreatorVideoCard(slug, null).kind).toBe("Brief");
    const cards = videoChannelCards("meta_ads", { briefs: [], library: [asset()], budget: null }, NOW);
    const { shown } = onePerKind(cards);
    expect(shown.map((c) => c.title)).toEqual([expect.stringMatching(/^Create a video brief for /), expect.stringMatching(/video is ready/)]);
    expect(shown.map((c) => c.kind)).toEqual(["Brief", "Ad"]);
  });
});

describe("the Waiting on card", () => {
  it("shows one card per job the creator still owes, and none for completed or cancelled", () => {
    const cards = ugcHubCards(
      {
        briefs: [],
        jobs: [
          job({ id: "a", status: "in_progress" }),
          job({ id: "b", status: "revision_requested" }),
          job({ id: "c", status: "awaiting_acceptance", awaiting_creator: true }),
          job({ id: "d", status: "completed" }),
          job({ id: "e", status: "cancelled" }),
        ],
        library: [],
        bookable: 0,
      },
      NOW,
    );
    expect(cards.filter((c) => c.kind === "Waiting").map((c) => c.id)).toEqual(["ugc-waiting-a", "ugc-waiting-b", "ugc-waiting-c"]);
    expect(cards).toHaveLength(3);
  });

  it("names the creator and the job, and Open job opens the job drawer", () => {
    const card = waitingCard(job({ status: "in_progress", title: "Spring launch video" }));
    expect(card.title).toBe("Waiting on Maya: Spring launch video");
    expect(card.primary).toEqual({ label: "Open job", target: { kind: "drawer", name: "job", params: { job: "j1" } } });
    expect(card.pane?.rows).toContainEqual(["Status", "Making the video"]);
  });

  it("says the due date when there is one", () => {
    const card = waitingCard(job({ status: "in_progress", due_at: "2026-10-04T12:00:00Z" }));
    expect(card.pane?.rows).toContainEqual(["Due", "Oct 4"]);
  });

  it("says when the clock starts for a booking not accepted yet", () => {
    const plain = waitingCard(job({ status: "awaiting_acceptance", awaiting_creator: true, due_at: null }));
    expect(plain.pane?.rows).toContainEqual(["Due", "7 days after they accept"]);
    expect(plain.pane?.rows).toContainEqual(["Status", "Waiting for them to accept"]);
    const fromBackend = waitingCard(
      job({ status: "awaiting_acceptance", awaiting_creator: true, due_after_accept: "5 days after Maya accepts" }),
    );
    expect(fromBackend.pane?.rows).toContainEqual(["Due", "5 days after Maya accepts"]);
  });

  it("an open ask for more time reads as the founder's decision, ranked before plain waiting", () => {
    const cards = ugcHubCards(
      {
        briefs: [],
        jobs: [
          job({ id: "w", status: "in_progress" }),
          job({
            id: "x",
            status: "in_progress",
            title: "Spring launch video",
            due_at: "2026-10-04T12:00:00Z",
            extension_state: "requested",
            extension_requested_due_at: "2026-10-09T12:00:00Z",
          }),
        ],
        library: [],
        bookable: 0,
      },
      NOW,
    );
    expect(cards.map((c) => c.id)).toEqual(["ugc-waiting-x", "ugc-waiting-w"]);
    const [ask] = cards;
    expect(ask.title).toBe("Maya asked for more time: Spring launch video");
    expect(ask.title).not.toMatch(/^Waiting on/);
    expect(ask.pane?.rows).toContainEqual(["Due now", "Oct 4"]);
    expect(ask.pane?.rows).toContainEqual(["New date asked", "Oct 9"]);
    expect(ask.primary.target).toEqual({ kind: "drawer", name: "job", params: { job: "x" } });
  });

  it("an ask left open after the video moved on (change requested) is plain waiting, not a decision", () => {
    const card = waitingCard(job({ status: "revision_requested", extension_state: "requested" }));
    expect(card.title).toBe("Waiting on Maya: 1 video");
    expect(card.pane?.rows).toContainEqual(["Status", "Making the change you asked for"]);
    const cards = ugcHubCards({ briefs: [], jobs: [job({ status: "revision_requested", extension_state: "requested" })], library: [], bookable: 0 }, NOW);
    expect(cards.map((c) => c.kind)).toEqual(["Waiting"]);
  });

  it("money copy: a booking not accepted yet is authorized, not charged; an accepted job's money is held", () => {
    const hold = waitingCard(job({ status: "awaiting_acceptance", awaiting_creator: true }));
    expect(hold.why).toEqual(["Your card is authorized but not charged yet. It is charged only if they accept."]);
    expect(waitingCard(job({ status: "in_progress" })).why).toEqual(["Zavi holds the money until you approve the video."]);
  });

  it("an answered ask (approved or declined) is back to plain waiting", () => {
    for (const state of ["approved", "declined"] as const)
      expect(waitingCard(job({ status: "in_progress", extension_state: state })).title).toBe("Waiting on Maya: 1 video");
  });

  it("does not promise a date before the product arrives", () => {
    const card = waitingCard(job({ status: "in_progress", product_needed: true, product_received_at: null }));
    expect(card.pane?.rows).toContainEqual(["Due", "Set once they receive your product"]);
  });
});
