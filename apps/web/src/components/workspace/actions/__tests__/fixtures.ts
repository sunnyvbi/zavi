
import type { ActionType } from "@/lib/workspace/actionTypes";
import type { ChannelActionBody, ChannelActionView } from "@/lib/workspace/channelActionsApi";

let seq = 0;

export function makeAction(
  action_type: ActionType,
  over: Partial<Omit<ChannelActionView, "body">> & { body?: ChannelActionBody } = {},
): ChannelActionView {
  seq += 1;
  return {
    id: `act-${action_type}-${seq}`,
    channel_slug: "x_organic",
    run_id: "run-1",
    position: 1,
    run_of: 5,
    blocking: false,
    action_type,
    title: `Title for ${action_type}`,
    body: {},
    status: "pending",
    note: null,
    snoozed_until: null,
    impact: 4,
    impact_reason: "Moves weekly signups: the last two posts like this drove most profile visits.",
    score: 71.5,
    score_inputs: { impact_n: 0.75, goal_fit: 1, rank_n: 1, previously_rejected: false },
    proposed_at: "2026-09-15T16:00:00Z",
    repeat_of: null,
    redo_of: null,
    source: "channel_action",
    executable: false,
    exec_status: null,
    edited_body: null,
    ...over,
  };
}

const evidence = [
  "Read the last 30 posts on the account this run",
  "Posts with a numbered list averaged 2.1x the replies of the rest",
  "The pinned post is 11 months old",
];

export const FIXTURES: Record<ActionType, ChannelActionView> = {
  text_post: makeAction("text_post", {
    title: "Post the three-step feedback rule",
    body: {
      step: {
        title: "Post the three-step feedback rule",
        body: "Numbered, practical posts are what your audience replies to. This one restates your onboarding advice in three lines.",
        blocking: false,
        effort: "minutes",
        evidence,
        deliverable: {
          kind: "post",
          label: "Post",
          content: "Our rule for product feedback:\n\n1. Write down the problem.\n2. Ask when it last happened.\n3. Watch the workaround.\n\nBuild after that, not before.",
        },
      },
    },
  }),
  image_post: makeAction("image_post", {
    title: "Share the before and after screenshot",
    body: {
      step: {
        body: "Visual posts get twice the reach of text on this account.",
        effort: "minutes",
        evidence,
        deliverable: { kind: "post", label: "Caption", content: "Same page, one change: the price is on it now. Signups went up the week after." },
      },
      media: { kind: "image", url: "https://cdn.example.com/before-after.png", alt: "Pricing page before and after" },
    },
  }),
  video_post: makeAction("video_post", {
    title: "Film a 30-second setup walkthrough",
    body: {
      step: {
        body: "Short walkthroughs are the most saved format in your niche.",
        effort: "hours",
        evidence,
        deliverable: { kind: "script", label: "Caption", content: "Setup in 30 seconds. No card, no call." },
      },
    },
  }),
  reply: makeAction("reply", {
    title: "Answer the question about pricing tiers",
    body: {
      step: {
        body: "A prospect asked publicly and nobody answered for two days.",
        effort: "minutes",
        evidence,
        deliverable: { kind: "comment", label: "Reply", content: "Good question. Every plan has every feature; you only pick how much you use." },
      },
      reply_to: { author: "@a_prospect", text: "Is there a free tier or do I have to talk to sales?", url: "https://x.com/a_prospect/status/1" },
    },
  }),
  send_message: makeAction("send_message", {
    channel_slug: "email_marketing",
    title: "Send the win-back email to lapsed trials",
    body: {
      step: {
        body: "212 trials lapsed in the last 30 days without a second session.",
        effort: "minutes",
        evidence,
        deliverable: { kind: "email", label: "Email", content: "Subject: Your project is still here\n\nYou started a project and stopped at step two. It takes about four minutes to finish." },
      },
      recipient: { name: "Lapsed trials (212)", channel: "Email" },
    },
  }),
  create_ad: makeAction("create_ad", {
    channel_slug: "google_ads",
    title: "Add a campaign for high-intent searches",
    executable: true,
    body: {
      change_sentence: "Zavi creates a paused Search campaign with a $20 daily budget.",
      exact_change: {
        rows: [
          { item: "Campaign", before: "None", after: "Search, high intent" },
          { item: "Daily budget", before: "None", after: "$20" },
        ],
      },
      decision_evidence: {
        stats: [{ value: "1,240", caption: "monthly searches for the top term" }],
        estimate: [{ value: "≈ 14", caption: "extra conversions a month" }],
      },
    },
  }),
  update_ad: makeAction("update_ad", {
    channel_slug: "google_ads",
    title: "Raise the budget on the campaign that is capped",
    body: {
      step: {
        body: "The campaign spent its full daily budget on 26 of 30 days and still has the lowest cost per conversion.",
        effort: "minutes",
        evidence,
        card_evidence: {
          stats: [
            { value: "26 of 30", caption: "days the budget ran out" },
            { value: "$18.40", caption: "cost per conversion" },
          ],
          window: { from: "Aug 17", to: "Sep 15" },
        },
      },
      exact_change: { rows: [{ item: "Daily budget", before: "$40", after: "$55" }] },
      link: "https://ads.google.com/aw/campaigns",
    },
  }),
  pause_ad: makeAction("pause_ad", {
    channel_slug: "google_ads",
    title: "Pause 4 keywords with no conversions in 60 days",
    executable: true,
    body: {
      change_sentence: "Zavi pauses 4 keywords, freeing about $310 a month.",
      exact_change: {
        rows: [
          { item: "cheap tool (phrase)", before: "Enabled", after: "Paused" },
          { item: "free tool (phrase)", before: "Enabled", after: "Paused" },
          { item: "tool jobs (exact)", before: "Enabled", after: "Paused" },
          { item: "how to build a tool (broad)", before: "Enabled", after: "Paused" },
        ],
      },
      decision_evidence: { stats: [{ value: "$310", caption: "spent with 0 conversions" }], reason_text: "None of these searches converted in 60 days." },
    },
  }),
  fix: makeAction("fix", {
    blocking: true,
    title: "Add the conversion tag to the signup page",
    body: {
      step: { body: "Without the tag no campaign can learn what a signup looks like.", blocking: true, effort: "minutes", evidence },
      link: "https://example.com/signup",
    },
  }),
  check: makeAction("check", {
    title: "Check why mobile signups dropped last week",
    body: { step: { body: "Mobile signups fell 38% week over week while desktop held flat.", effort: "hours", evidence } },
  }),
  setup: makeAction("setup", {
    title: "Claim your business profile",
    body: {
      step: {
        body: "An unclaimed profile shows old hours and no link.",
        effort: "minutes",
        evidence,
        deliverable: { kind: "list", label: "Details to enter", content: "Name, category, website, hours" },
      },
    },
  }),
  page: makeAction("page", {
    channel_slug: "seo",
    title: "Rewrite the pricing page title and intro",
    body: {
      step: {
        body: "The title does not contain the term people search for.",
        effort: "hours",
        evidence,
        deliverable: { kind: "page_copy", label: "Page copy", content: "Pricing that grows with you. Start free, pay for what you use." },
      },
      link: "https://example.com/pricing",
    },
  }),
  other: makeAction("other", {
    title: "Ask three recent customers for a quote",
    body: { step: { body: "Social proof is missing from every landing page.", effort: "days", evidence } },
  }),
};
