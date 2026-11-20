
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { postContent } from "../actions/types";
import type { XAttention, XDraft } from "./XAgentDashboard";

const apiFetch = vi.hoisted(() => vi.fn());
const approveDecision = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision }));

const { publishPost, stagedCardProposal, stagedCardsFromPayload, stagedProposalFor, xPanelSections } = await import("./xStagedPosts");

const POST_TEXT =
  "Three things we changed after reading every support reply from last month, and what each one did to reply time.";

function stagedDraft(over: Partial<XDraft> = {}): XDraft {
  return {
    decision_id: "dec-staged-1",
    source: "staged",
    label: null,
    needs_confirm: false,
    channel: "x",
    text: POST_TEXT,
    thread: null,
    image_path: null,
    video_path: null,
    scheduled_at: null,
    rationale: null,
    emitted_at: "2026-09-19T09:00:00Z",
    ...over,
  };
}

function action(id: string, over: Partial<ChannelActionView> = {}): ChannelActionView {
  return {
    id,
    channel_slug: "x_organic",
    run_id: "run-1",
    position: 1,
    run_of: 4,
    blocking: false,
    action_type: "text_post",
    title: "Post the three-change rundown",
    body: { step: { title: "Post the three-change rundown", deliverable: { kind: "post", label: "Post", content: POST_TEXT } } },
    status: "pending",
    note: null,
    snoozed_until: null,
    impact: 4,
    impact_reason: null,
    score: 70,
    score_inputs: {},
    proposed_at: "2026-09-19T09:00:00Z",
    repeat_of: null,
    redo_of: null,
    source: "channel_action",
    executable: false,
    exec_status: null,
    edited_body: null,
    ...over,
  };
}

function approvalRow(actionId: string): XAttention {
  return {
    key: `step:${actionId}`,
    title: "Rewrite the bio",
    detail: "The bio does not say what you sell.",
    mode: "approval",
    status: "open",
    effort: "2 min",
    decision_id: actionId,
    link: null,
    blocking: false,
  };
}

const profileRow: XAttention = {
  key: "avatar",
  title: "Add a profile photo",
  detail: "The account still has the default egg.",
  mode: "manual",
  status: "open",
  effort: "2 min",
  decision_id: null,
  link: "https://x.com/settings/profile",
  blocking: false,
};

beforeEach(() => {
  apiFetch.mockReset();
  approveDecision.mockReset();
  approveDecision.mockResolvedValue({ ok: true, json: async () => ({}) });
});

describe("a channel action whose post is already staged", () => {
  it("publishes through the staged proposal: zero new proposals, one approve", async () => {
    const draft = stagedDraft();
    const card = action("act-1");
    const sections = xPanelSections({
      switched: true,
      drafts: [draft],
      attention: [profileRow],
      channelActions: [card],
    });

    expect(sections.cards.map((c) => c.id)).toEqual(["act-1"]);
    expect(sections.stagedFor.get("act-1")?.decision_id).toBe("dec-staged-1");

    await publishPost({
      channel: "x",
      staged: sections.stagedFor.get("act-1") ?? null,
      content: postContent(card),
    });

    expect(apiFetch).toHaveBeenCalledTimes(0);
    expect(approveDecision).toHaveBeenCalledTimes(1);
    expect(approveDecision.mock.calls[0][0]).toBe("dec-staged-1");
  });

  it("stages exactly one proposal when there is none to reuse", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ decision_id: "dec-new-1" }) });

    await publishPost({ channel: "x", staged: null, content: { text: POST_TEXT, thread: null } });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toBe("/api/social/propose");
    expect(approveDecision).toHaveBeenCalledTimes(1);
    expect(approveDecision.mock.calls[0][0]).toBe("dec-new-1");
  });

  it("sends the founder's edit as a replacement body, still on the one proposal", async () => {
    const draft = stagedDraft();
    await publishPost({
      channel: "x",
      staged: draft,
      content: { text: "A shorter version of the same post.", thread: null },
    });

    expect(apiFetch).toHaveBeenCalledTimes(0);
    expect(approveDecision).toHaveBeenCalledTimes(1);
    expect(approveDecision.mock.calls[0][1]).toMatchObject({ payload_text: "A shorter version of the same post." });
  });

  it.each(["x", "linkedin"] as const)("stages edited %s images with retry protection", async (channel) => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ decision_id: "dec-new-image" }) });
    const image_path = "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.png";

    await publishPost({ channel, staged: null, content: { text: POST_TEXT, thread: null, image_path } });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, options] = apiFetch.mock.calls[0];
    expect(path).toBe("/api/social/propose");
    expect(options.idempotent).toBe(true);
    expect(JSON.parse(options.body)).toMatchObject({ channel: `${channel}_image`, payload: { text: POST_TEXT, image_path } });
    expect(approveDecision).toHaveBeenCalledTimes(1);
  });
});

describe("a staged proposal no channel action claims", () => {
  it("is still a card, carries its own copy, and approves on its own id", async () => {
    const orphan = stagedDraft({ decision_id: "dec-orphan", text: "A one-off post the founder asked for by name." });
    const unrelated = action("act-2", {
      body: { step: { title: "Fix the pinned post", deliverable: { kind: "post", label: "Post", content: POST_TEXT } } },
    });
    const sections = xPanelSections({
      switched: true,
      drafts: [orphan],
      attention: [profileRow],
      channelActions: [unrelated],
    });

    const card = sections.cards.find((c) => c.id === "dec-orphan");
    expect(card).toBeDefined();
    expect(postContent(card!).text).toBe("A one-off post the founder asked for by name.");
    expect(sections.stagedCardIds.has("dec-orphan")).toBe(true);

    await publishPost({ channel: "x", staged: sections.stagedFor.get("dec-orphan") ?? null, content: postContent(card!) });
    expect(apiFetch).toHaveBeenCalledTimes(0);
    expect(approveDecision).toHaveBeenCalledTimes(1);
    expect(approveDecision.mock.calls[0][0]).toBe("dec-orphan");
  });
});

describe("stagedCardProposal — a staged card posts itself", () => {
  it("a run-less staged card is its own proposal, carrying the run's copy", () => {
    const card = { ...action("dec-image", { run_id: null }), edited_body: { text: "Edited.", thread: null } };
    expect(stagedCardProposal(card, "x")).toMatchObject({ decision_id: "dec-image", text: POST_TEXT, channel: "x" });
  });

  it("a channel-action card is not: it pairs on the copy instead", () => {
    expect(stagedCardProposal(action("action-1"), "x")).toBeNull();
  });
});

describe("a snoozed or unreadable staged list", () => {
  it("a snoozed proposal is no card, but a copy match still finds it", () => {
    const payload = { drafts: [stagedDraft({ snoozed_until: "2999-01-01T00:00:00Z" })] };
    expect(stagedCardsFromPayload(payload, [])).toEqual([]);
    expect(stagedProposalFor(payload, POST_TEXT)?.decision_id).toBe("dec-staged-1");
  });

  it("refuses to pair when the staged read failed", () => {
    expect(() => stagedProposalFor({ drafts: [], drafts_ok: false }, POST_TEXT)).toThrow(/could not check/);
  });
});

describe("nothing renders twice", () => {
  it("shares no id between the action list and the attention rows", () => {
    const sections = xPanelSections({
      switched: true,
      drafts: [stagedDraft()],
      attention: [profileRow, approvalRow("act-1"), approvalRow("act-bio")],
      channelActions: [action("act-1"), action("act-bio", { action_type: "fix", body: { step: { title: "Rewrite the bio" } } })],
    });

    const cardIds = new Set(sections.cards.map((c) => c.id));
    expect(cardIds).toEqual(new Set(["act-1", "act-bio"]));
    for (const row of sections.attention) {
      expect(cardIds.has(row.decision_id ?? "")).toBe(false);
      expect(cardIds.has(row.key.replace(/^step:/, ""))).toBe(false);
    }
    expect(sections.attention.map((r) => r.key)).toEqual(["avatar"]);
  });

  it("leaves an unswitched channel exactly as it was", () => {
    const step = stagedDraft({ decision_id: "dec-step", source: "step" });
    const sections = xPanelSections({
      switched: false,
      drafts: [stagedDraft(), step],
      attention: [profileRow, approvalRow("dec-x")],
      channelActions: [],
    });
    expect(sections.cards.map((c) => c.id)).toEqual(["dec-staged-1", "dec-step"]);
    expect(sections.attention).toHaveLength(2);
    expect(sections.stagedCardIds.size).toBe(0);
  });
});

describe("stagedCardsFromPayload — what the channel page draws", () => {
  const done: XAttention = { ...profileRow, key: "pinned", title: "No pinned post", status: "done" };

  it("drops a check already marked done", () => {
    const cards = stagedCardsFromPayload({ drafts: [], attention: [profileRow, done] }, []);
    expect(cards.map((c) => c.title)).toEqual(["Add a profile photo"]);
  });

  it("keeps every check that is still open", () => {
    const cards = stagedCardsFromPayload({ drafts: [], attention: [profileRow] }, []);
    expect(cards.map((c) => c.id)).toEqual(["check:avatar"]);
  });
});

describe("edited post images", () => {
  const image = "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg";
  it("reuses the pending proposal and sends its edited image through approval", async () => {
    await publishPost({ channel: "x", staged: stagedDraft(), content: { text: POST_TEXT, thread: null, image_path: image } });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(approveDecision).toHaveBeenCalledTimes(1);
    expect(approveDecision).toHaveBeenCalledWith("dec-staged-1", { image_path: image });
  });
  it("stages a new image post with the corresponding image transport", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ decision_id: "image-draft" }) });
    await publishPost({ channel: "linkedin", staged: null, content: { text: POST_TEXT, thread: null, image_path: image } });
    const request = apiFetch.mock.calls[0][1];
    expect(JSON.parse(request.body)).toMatchObject({ channel: "linkedin_image", payload: { image_path: image, text: POST_TEXT } });
    expect(approveDecision).toHaveBeenCalledTimes(1);
  });
});

it("preserves the staged card's displayed revision through approval", async () => {
  const revision = "a".repeat(64);
  const sections = xPanelSections({ switched: true, drafts: [stagedDraft({ post_revision: revision })], attention: [], channelActions: [] });
  const staged = stagedCardProposal(sections.cards[0], "x");
  expect(staged?.post_revision).toBe(revision);
  await publishPost({ channel: "x", staged, content: { text: POST_TEXT, thread: null } });
  expect(approveDecision).toHaveBeenCalledWith("dec-staged-1", { expected_post_revision: revision });
});

it("approves a just-saved revision instead of the older dashboard revision", async () => {
  await publishPost({ channel: "x", staged: stagedDraft({ post_revision: "a".repeat(64) }), content: { text: "Saved here", thread: null, post_revision: "b".repeat(64) } });
  expect(approveDecision).toHaveBeenCalledWith("dec-staged-1", { payload_text: "Saved here", thread: null, expected_post_revision: "b".repeat(64) });
});

it("keeps the paired saved draft ahead of an older edit on the channel action", () => {
  const draft = stagedDraft({ post_revision: "a".repeat(64), original_text: POST_TEXT, text: "Saved on the proposal", edited_body: { text: "Saved on the proposal", thread: null } });
  const old = action("paired-action", { edited_body: { text: "Older action edit", thread: null }, body: { thread: ["Old tail"], media: { kind: "image", url: "https://example.com/old.png" }, step: { deliverable: { kind: "post", content: POST_TEXT, parts: [{ content: "Old variant" }, { content: "Other variant" }] } } } });
  const [card] = stagedCardsFromPayload({ drafts: [draft] }, [old]);
  expect(postContent(card)).toEqual({ text: "Saved on the proposal", thread: null });
  expect(card.staged_draft_id).toBe(draft.decision_id);
  expect(card.post_revision).toBe(draft.post_revision);
  expect(card.body.media).toBeUndefined();
  expect(card.body.step?.deliverable?.parts).toBeUndefined();
});

it("keeps a snoozed draft paired to its existing action while hiding loose snoozed drafts", () => {
  const draft = stagedDraft({ post_revision: "a".repeat(64), snoozed_until: "2999-01-01T00:00:00Z" });
  const cards = stagedCardsFromPayload({ drafts: [draft] }, [action("paired-action")]);
  expect(cards).toHaveLength(1);
  expect(cards[0].staged_draft_id).toBe(draft.decision_id);
  expect(cards[0].post_revision).toBe(draft.post_revision);
  expect(stagedCardsFromPayload({ drafts: [draft] }, [])).toEqual([]);
});
