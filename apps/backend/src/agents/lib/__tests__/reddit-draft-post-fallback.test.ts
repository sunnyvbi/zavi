import { describe, expect, it } from "vitest";
import {
  ensureRedditDraftPostStep,
  shouldEmitRedditOrganic,
  transformRedditDraftPost,
} from "../reddit-draft-post-fallback";
import { stepDecisionBodies } from "../channel-recipe-step";

const draftPayload = {
  channel_slug: "reddit_organic",
  top_action: {
    key: "draft_post",
    inputs: { community: "r/smallbusiness", topic: "pricing" },
    instruction: "server instruction",
    by: "founder-id",
  },
};

describe("Reddit draft-post fallback", () => {
  it("does not emit an empty ordinary Reddit run", () => {
    expect(shouldEmitRedditOrganic({ rendered_markdown: "Nothing due.", steps: [] }, {})).toBe(false);
  });

  it("turns an empty draft-post run into one non-publishable explanation card", () => {
    const parsed = { rendered_markdown: "The community rules could not be read.", steps: [] };
    expect(shouldEmitRedditOrganic(parsed, draftPayload)).toBe(true);
    const bodies = stepDecisionBodies(ensureRedditDraftPostStep(parsed, draftPayload));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      of: 1,
      step: {
        action_type: "check",
        body: "Zavi finished the draft run but did not produce a safe post. Review the run summary, then try again.",
      },
    });
    expect((bodies[0] as { step: { deliverable?: unknown } }).step.deliverable).toBeUndefined();
  });

  it("preserves a valid draft step", () => {
    const parsed = {
      rendered_markdown: "Draft ready.",
      steps: [{
        title: "Post this draft",
        body: "A useful post.",
        blocking: false,
        effort: "minutes",
        evidence: ["Read r/smallbusiness rules."],
        deliverable: { kind: "post", label: "Draft", content: "Hello Reddit" },
      }],
    };
    expect(stepDecisionBodies(ensureRedditDraftPostStep(parsed, draftPayload))).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: expect.objectContaining({ title: "Post this draft" }) }),
    ]));
  });

  it("turns an inline Title: line into a reddit_post presentation so the card can copy title and body apart", () => {
    const body = "Hosts keep asking what the protection plan really covers. Here is what to check before you list a car, in plain terms.";
    const parsed = {
      rendered_markdown: "Draft ready.",
      steps: [{
        title: "Draft: r/smallbusiness post",
        body: "Read the rules first.",
        blocking: false,
        effort: "minutes",
        evidence: ["Read r/smallbusiness rules."],
        deliverable: { kind: "post", label: "Draft", content: `**Title:** What to check in a protection plan before you list\n\nBody:\n\n${body}` },
      }],
    };
    const out = ensureRedditDraftPostStep(parsed, draftPayload) as { steps: Array<{ deliverable: { content: string; presentation: Record<string, unknown> } }> };
    expect(out).not.toBe(parsed);
    expect(out.steps[0].deliverable.content).toBe(body);
    expect(out.steps[0].deliverable.presentation).toMatchObject({
      type: "reddit_post",
      subreddit: "smallbusiness",
      title: "What to check in a protection plan before you list",
      post_type: "text",
      affiliation_disclosure: "not_applicable",
      rule_status: "verify_manually",
    });
    const bodies = stepDecisionBodies(out);
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as { step: { deliverable: { presentation: { type: string } } } }).step.deliverable.presentation.type).toBe("reddit_post");
  });

  it("marks the disclosure when the body opens with one, and leaves copy with no Title: line alone", () => {
    const disclosed = "Disclosure: I work on Upcar, so weigh this. Here is how to compare protection plans as a host before you list.";
    const shaped = ensureRedditDraftPostStep({
      rendered_markdown: "Draft ready.",
      steps: [{
        title: "Draft", body: "b", blocking: false, effort: "minutes", evidence: ["e"],
        deliverable: { kind: "post", label: "Draft", content: `Title: Comparing host protection plans honestly\n${disclosed}` },
      }],
    }, draftPayload) as { steps: Array<{ deliverable: { presentation: { affiliation_disclosure: string } } }> };
    expect(shaped.steps[0].deliverable.presentation.affiliation_disclosure).toBe("first_line");
    const plain = {
      rendered_markdown: "Draft ready.",
      steps: [{
        title: "Draft", body: "b", blocking: false, effort: "minutes", evidence: ["e"],
        deliverable: { kind: "post", label: "Draft", content: "Hello Reddit, a post with no title line at all." },
      }],
    };
    expect(ensureRedditDraftPostStep(plain, draftPayload)).toBe(plain);
  });

  it("does not add a fallback to an ordinary run after its steps are removed", () => {
    const parsed = { rendered_markdown: "Nothing safe remained.", steps: [] };
    expect(ensureRedditDraftPostStep(parsed, {})).toBe(parsed);
  });

  it("replaces a draft explanation removed by a gate with the safe fallback", async () => {
    const transform = async (envelope: unknown) => {
      const value = envelope as { rendered_markdown: string; steps: Array<{ body: string }> };
      return {
        envelope: {
          ...value,
          steps: value.steps.filter((step) => !step.body.includes("apify__")),
        },
      };
    };
    const parsed = {
      rendered_markdown: "The rules read failed.",
      steps: [{
        title: "Could not read rules",
        body: "apify__scrape_reddit failed.",
        blocking: false,
        effort: "minutes",
        evidence: ["The rules request failed."],
      }],
    };

    const result = await transformRedditDraftPost(parsed, draftPayload, transform);

    expect(stepDecisionBodies(result.envelope)).toEqual([
      expect.objectContaining({
        step: expect.objectContaining({
          title: "Reddit post could not be drafted",
          body: expect.not.stringContaining("apify__"),
        }),
      }),
    ]);
  });

  const potential = { level: "moderate", confidence: "medium", reasons: ["Matches what the community asks."] };
  const postStep = {
    title: "Post this draft",
    body: "A useful post.",
    blocking: false,
    effort: "minutes",
    evidence: ["Read r/smallbusiness rules."],
    deliverable: {
      kind: "post",
      label: "Draft",
      content: "Here is how we chase late invoices without being rude to clients.",
      presentation: {
        type: "reddit_post",
        subreddit: "smallbusiness",
        title: "How do you chase late invoices politely?",
        post_type: "text",
        style: "question",
        affiliation_disclosure: "not_applicable",
        rule_status: "ready",
        potential,
      },
    },
  };
  const replyStep = {
    title: "Reply on this thread",
    body: "A reply instead of a post.",
    blocking: false,
    effort: "minutes",
    evidence: ["Found a thread."],
    deliverable: {
      kind: "post",
      label: "Reply",
      content: "Send a reminder three days before the due date, then a firm one after.",
      presentation: {
        type: "reddit_reply",
        subreddit: "smallbusiness",
        thread_title: "Late invoices",
        thread_url: "https://www.reddit.com/r/smallbusiness/comments/abc/",
        reply_style: "advice",
        rule_status: "ready",
        potential,
      },
    },
  };
  const explainStep = {
    title: "Rules could not be read",
    body: "The community's rules could not be read today.",
    blocking: false,
    effort: "minutes",
    evidence: ["Rules read failed."],
    action_type: "check",
  };
  const titles = (out: unknown) =>
    stepDecisionBodies(out).map((b) => (b as { step: { title: string } }).step.title);

  it("drops a reply card a draft-post run returned and keeps only the post", () => {
    const parsed = { rendered_markdown: "Draft ready.", steps: [replyStep, postStep] };
    expect(titles(ensureRedditDraftPostStep(parsed, draftPayload))).toEqual(["Post this draft"]);
  });

  it("replaces a draft-post run that returned only a reply card with the safe fallback, never a publishable reply", () => {
    const parsed = { rendered_markdown: "Reply ready.", steps: [replyStep] };
    const bodies = stepDecisionBodies(ensureRedditDraftPostStep(parsed, draftPayload));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ step: { title: "Reddit post could not be drafted", action_type: "check" } });
    expect((bodies[0] as { step: { deliverable?: unknown } }).step.deliverable).toBeUndefined();
  });

  it("falls back when only a deliverable-free step survives the reply being dropped", () => {
    const parsed = { rendered_markdown: "Mixed.", steps: [explainStep, replyStep] };
    expect(titles(ensureRedditDraftPostStep(parsed, draftPayload))).toEqual(["Reddit post could not be drafted"]);
  });

  it("returns the same envelope untouched when no step carries a foreign deliverable", () => {
    const withPost = { rendered_markdown: "Draft ready.", steps: [explainStep, postStep] };
    expect(ensureRedditDraftPostStep(withPost, draftPayload)).toBe(withPost);
    const onlyExplain = { rendered_markdown: "Could not draft.", steps: [explainStep] };
    expect(ensureRedditDraftPostStep(onlyExplain, draftPayload)).toBe(onlyExplain);
  });

  it("leaves an ordinary Reddit run's reply cards alone", () => {
    const parsed = { rendered_markdown: "Replies.", steps: [replyStep] };
    expect(ensureRedditDraftPostStep(parsed, {})).toBe(parsed);
  });
});
