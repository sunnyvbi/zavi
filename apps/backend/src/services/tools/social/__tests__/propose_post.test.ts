
import { describe, it, expect, vi, beforeEach } from "vitest";
const findBoard = vi.hoisted(() => vi.fn());
const readiness = vi.hoisted(() => vi.fn());
vi.mock("@/services/tools/pinterest-insights/read", () => ({ findOwnedPinterestBoard: findBoard }));
vi.mock("@/services/connectors/pinterest-composio/readiness", () => ({ resolvePinterestPublishReadiness: readiness }));
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ rpc }) }));
import { socialProposePostTool, buildProposePayload } from "../propose_post";
import { ExpectedToolError } from "@/services/tools/types";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER = "e0fe9ea8-0000-4000-8000-000000000000";
const IMG = `${TENANT}/9f9f9f9f-0000-4000-8000-000000000000.jpg`;

function ctx(emit = vi.fn().mockResolvedValue("dec-1")) {
  return { tenant_id: TENANT, emit_decision: emit, log: vi.fn() } as never;
}

async function expectRefusal(input: unknown, code: string, c = ctx()) {
  await expect(socialProposePostTool.execute(c, input)).rejects.toMatchObject({ code });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SOCIAL_PUBLISH_LOCAL_OVERRIDE_TENANTS", "");
  rpc.mockResolvedValue({ data: true, error: null });
});

describe("buildProposePayload", () => {
  it("shapes each channel's payload to exactly what its strict schema expects", () => {
    expect(buildProposePayload({ channel: "linkedin", text: "t", rationale: "r" })).toEqual({ text: "t" });
    expect(buildProposePayload({ channel: "x", text: "t", rationale: "r" })).toEqual({ text: "t" });
    expect(buildProposePayload({ channel: "linkedin_image", text: "t", image_path: IMG, rationale: "r" })).toEqual({
      text: "t",
      image_path: IMG,
    });
    expect(buildProposePayload({ channel: "reddit", text: "b", subreddit: "SaaS", title: "T", rationale: "r" })).toEqual({
      subreddit: "SaaS",
      title: "T",
      text: "b",
    });
  });
});

describe("social__propose_post — happy paths emit exactly one decision", () => {
  it("linkedin text", async () => {
    const emit = vi.fn().mockResolvedValue("dec-li");
    const out = (await socialProposePostTool.execute(ctx(emit), {
      channel: "linkedin",
      text: "Hello LinkedIn",
      rationale: "grounded in this week's payout data",
    })) as Record<string, unknown>;
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith("social.publish.v2", {
      channel: "linkedin",
      payload: { text: "Hello LinkedIn" },
      scheduled_at: null,
      rationale: "grounded in this week's payout data",
      origin: "agent_social_tool",
    });
    expect(out).toMatchObject({ decision_id: "dec-li", staged: true, published: false });
  });

  it("linkedin_image with a tenant-owned path", async () => {
    const emit = vi.fn().mockResolvedValue("dec-img");
    await socialProposePostTool.execute(ctx(emit), {
      channel: "linkedin_image",
      text: "caption",
      image_path: IMG,
      rationale: "r",
    });
    expect(emit.mock.calls[0][1]).toMatchObject({ channel: "linkedin_image", payload: { text: "caption", image_path: IMG } });
  });

  it("reddit self-post carries subreddit + title", async () => {
    const emit = vi.fn().mockResolvedValue("dec-r");
    await socialProposePostTool.execute(ctx(emit), {
      channel: "reddit",
      subreddit: "SaaS",
      title: "How we cut churn",
      text: "body",
      rationale: "r",
    });
    expect(emit.mock.calls[0][1]).toMatchObject({
      channel: "reddit",
      payload: { subreddit: "SaaS", title: "How we cut churn", text: "body" },
    });
  });

  it("passes an ISO scheduled_at through to the decision body (judged at approval, not here)", async () => {
    const emit = vi.fn().mockResolvedValue("dec-s");
    await socialProposePostTool.execute(ctx(emit), {
      channel: "linkedin",
      text: "Later",
      rationale: "r",
      scheduled_at: "2099-01-02T09:00:00Z",
    });
    expect(emit.mock.calls[0][1]).toMatchObject({ scheduled_at: "2099-01-02T09:00:00Z" });
  });

  it("refuses a non-ISO scheduled_at at parse (the model must send a real timestamp)", async () => {
    const emit = vi.fn();
    await expect(
      socialProposePostTool.execute(ctx(emit), { channel: "linkedin", text: "x", rationale: "r", scheduled_at: "tomorrow 9am" }),
    ).rejects.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });

  it("the return value never claims publication", async () => {
    const out = (await socialProposePostTool.execute(ctx(), {
      channel: "linkedin",
      text: "x",
      rationale: "r",
    })) as { published: boolean; note: string };
    expect(out.published).toBe(false);
    expect(out.note).toMatch(/Nothing is live/);
  });

  it("the note sends the founder to the channel's own page, never Needs you", async () => {
    const out = (await socialProposePostTool.execute(ctx(), {
      channel: "x",
      text: "x",
      rationale: "r",
    })) as { note: string };
    expect(out.note).toContain("X channel page (Growth Channels → X)");
    expect(out.note).not.toMatch(/needs you/i);
  });

  it("publishing_paused reports the live rail: false when the config switch is on", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const out = (await socialProposePostTool.execute(ctx(), { channel: "linkedin", text: "x", rationale: "r" })) as Record<string, unknown>;
    expect(rpc).toHaveBeenCalledWith("_social_publish_enabled");
    expect(out.publishing_paused).toBe(false);
  });

  it("publishing_paused is true when system_config pauses the rail, and the post is still staged", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    const emit = vi.fn().mockResolvedValue("dec-p");
    const out = (await socialProposePostTool.execute(ctx(emit), { channel: "linkedin", text: "x", rationale: "r" })) as Record<string, unknown>;
    expect(emit).toHaveBeenCalledOnce();
    expect(out).toMatchObject({ decision_id: "dec-p", staged: true, publishing_paused: true });
  });

  it("publishing_paused is omitted when the switch cannot be read, so the model never guesses from a blip", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const out = (await socialProposePostTool.execute(ctx(), { channel: "linkedin", text: "x", rationale: "r" })) as Record<string, unknown>;
    expect(out).not.toHaveProperty("publishing_paused");
    expect(out.staged).toBe(true);
  });
});

describe("social__propose_post — refusals", () => {
  it("refuses when the runner did not plumb emit_decision (cannot stage silently)", async () => {
    const c = { tenant_id: TENANT, log: vi.fn() } as never;
    await expectRefusal({ channel: "linkedin", text: "x", rationale: "r" }, "social_propose_no_emit", c);
  });

  it("stages an x text post (enabled 2026-09-08) and refuses one over 280 chars", async () => {
    const emit = vi.fn().mockResolvedValue("dec-x");
    const out = (await socialProposePostTool.execute(ctx(emit), {
      channel: "x",
      text: "Hello X",
      rationale: "r",
    })) as { decision_id: string; channel: string };
    expect(out.decision_id).toBe("dec-x");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toMatchObject({ channel: "x", payload: { text: "Hello X" } });
    await expectRefusal({ channel: "x", text: "y".repeat(281), rationale: "r" }, "social_propose_invalid_payload");
  });

  it("refuses a channel the input enum does not allow (myspace) before anything else", async () => {
    await expect(
      socialProposePostTool.execute(ctx(), { channel: "myspace", text: "x", rationale: "r" }),
    ).rejects.toThrow();
  });

  it("REFUSES a cross-tenant image path — may not even stage a cross-tenant read", async () => {
    const emit = vi.fn();
    await expectRefusal(
      { channel: "linkedin_image", text: "x", image_path: `${OTHER}/9f9f9f9f-0000-4000-8000-000000000000.jpg`, rationale: "r" },
      "social_propose_image_not_owned",
      ctx(emit),
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("REFUSES a URL as image_path — only storage paths are publishable", async () => {
    await expectRefusal(
      { channel: "linkedin_image", text: "x", image_path: "https://evil.example/x.jpg", rationale: "r" },
      "social_propose_image_not_owned",
    );
  });

  it("refuses linkedin_image with no image_path at all", async () => {
    await expectRefusal({ channel: "linkedin_image", text: "x", rationale: "r" }, "social_propose_image_not_owned");
  });

  it("surfaces the strict-schema message so the agent can fix it (r/ prefix)", async () => {
    const emit = vi.fn();
    await expect(
      socialProposePostTool.execute(ctx(emit), {
        channel: "reddit",
        subreddit: "r/SaaS",
        title: "t",
        text: "b",
        rationale: "r",
      }),
    ).rejects.toMatchObject({ code: "social_propose_invalid_payload" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("refuses reddit with no title (channel schema requires it)", async () => {
    await expectRefusal({ channel: "reddit", subreddit: "SaaS", text: "b", rationale: "r" }, "social_propose_invalid_payload");
  });

  it("refuses over-limit LinkedIn text via the channel schema (3000)", async () => {
    await expectRefusal({ channel: "linkedin", text: "a".repeat(3001), rationale: "r" }, "social_propose_invalid_payload");
  });

  it("every refusal is an ExpectedToolError (recoverable for the agent), not a crash", async () => {
    try {
      await socialProposePostTool.execute(ctx(), { channel: "reddit", subreddit: "SaaS", text: "b", rationale: "r" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExpectedToolError);
    }
  });
});

describe("social__propose_post — instagram_image + youtube_video (2026-09-03)", () => {
  const VID = `${TENANT}/9f9f9f9f-0000-4000-8000-000000000000.mp4`;

  it("buildProposePayload shapes both to their strict schemas (privacy only when given)", () => {
    expect(buildProposePayload({ channel: "instagram_image", text: "cap", image_path: IMG, rationale: "r" })).toEqual({
      text: "cap",
      image_path: IMG,
    });
    expect(buildProposePayload({ channel: "youtube_video", text: "desc", title: "T", video_path: VID, rationale: "r" })).toEqual({
      title: "T",
      text: "desc",
      video_path: VID,
    });
    expect(
      buildProposePayload({ channel: "youtube_video", text: "desc", title: "T", video_path: VID, privacy: "unlisted", rationale: "r" }),
    ).toEqual({ title: "T", text: "desc", video_path: VID, privacy: "unlisted" });
  });

  it("instagram_image with a tenant-owned image stages one decision", async () => {
    const emit = vi.fn().mockResolvedValue("dec-ig");
    await socialProposePostTool.execute(ctx(emit), { channel: "instagram_image", text: "cap", image_path: IMG, rationale: "r" });
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][1]).toMatchObject({ channel: "instagram_image", payload: { text: "cap", image_path: IMG } });
  });

  it("youtube_video with a tenant-owned video stages one decision; the schema defaults privacy to public", async () => {
    const emit = vi.fn().mockResolvedValue("dec-yt");
    await socialProposePostTool.execute(ctx(emit), { channel: "youtube_video", text: "desc", title: "Launch", video_path: VID, rationale: "r" });
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][1]).toMatchObject({
      channel: "youtube_video",
      payload: { title: "Launch", text: "desc", video_path: VID, privacy: "public" },
    });
  });

  it("instagram_image refuses another tenant's image path and a URL (never even staged)", async () => {
    await expectRefusal({ channel: "instagram_image", text: "c", image_path: `${OTHER}/9f9f9f9f-0000-4000-8000-000000000000.jpg`, rationale: "r" }, "social_propose_image_not_owned");
    await expectRefusal({ channel: "instagram_image", text: "c", image_path: "https://evil.example/x.jpg", rationale: "r" }, "social_propose_image_not_owned");
  });

  it("youtube_video refuses another tenant's video, a URL, an image where a video is expected, and a missing path", async () => {
    await expectRefusal({ channel: "youtube_video", text: "d", title: "T", video_path: `${OTHER}/9f9f9f9f-0000-4000-8000-000000000000.mp4`, rationale: "r" }, "social_propose_image_not_owned");
    await expectRefusal({ channel: "youtube_video", text: "d", title: "T", video_path: "https://evil.example/v.mp4", rationale: "r" }, "social_propose_image_not_owned");
    await expectRefusal({ channel: "youtube_video", text: "d", title: "T", video_path: IMG, rationale: "r" }, "social_propose_image_not_owned");
    await expectRefusal({ channel: "youtube_video", text: "d", title: "T", rationale: "r" }, "social_propose_image_not_owned");
  });

  it("youtube_video without a title fails the strict schema (surfaced as invalid_payload), emitting nothing", async () => {
    const emit = vi.fn().mockResolvedValue("x");
    await expectRefusal({ channel: "youtube_video", text: "d", video_path: VID, rationale: "r" }, "social_propose_invalid_payload", ctx(emit));
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("social__propose_post — x threads", () => {
  it("accepts a long URL in a tail as one unchanged proposal", async () => {
    const emit = vi.fn().mockResolvedValue("thread");
    const tail = "Read https://example.com/" + "a".repeat(290);
    await socialProposePostTool.execute(ctx(emit), { channel: "x", text: "root", thread: [tail], rationale: "r" });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toMatchObject({ payload: { text: "root", thread: [tail] } });
  });

  it("refuses a weighted-overflow tail before emitting a card", async () => {
    const emit = vi.fn();
    await expect(socialProposePostTool.execute(ctx(emit), { channel: "x", text: "root", thread: ["界".repeat(141)], rationale: "r" })).rejects.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });
  it("stages a thread as ONE decision with the tail in the payload", async () => {
    const emit = vi.fn().mockResolvedValue("dec-thread");
    await socialProposePostTool.execute(ctx(emit), {
      channel: "x",
      text: "root",
      thread: ["two", "three"],
      rationale: "r",
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toMatchObject({ channel: "x", payload: { text: "root", thread: ["two", "three"] } });
  });

  it("a thread on a non-x channel is refused by the strict payload schema", async () => {
    await expectRefusal({ channel: "linkedin", text: "t", thread: ["x"], rationale: "r" }, "social_propose_invalid_payload");
  });

  it("more than four parts is refused", async () => {
    await expect(
      socialProposePostTool.execute(ctx(), { channel: "x", text: "t", thread: ["1", "2", "3", "4", "5"], rationale: "r" }),
    ).rejects.toBeTruthy();
  });

  it("buildProposePayload omits thread when absent", () => {
    expect(buildProposePayload({ channel: "x", text: "t", rationale: "r" })).toEqual({ text: "t" });
  });
});

describe("social__propose_post — x_image / x_video", () => {
  const VID = `${TENANT}/9f9f9f9f-0000-4000-8000-000000000000.mp4`;

  it("stages an image post with a tenant-owned path", async () => {
    const emit = vi.fn().mockResolvedValue("dec-xi");
    await socialProposePostTool.execute(ctx(emit), { channel: "x_image", text: "pic", image_path: IMG, rationale: "r" });
    expect(emit.mock.calls[0][1]).toMatchObject({ channel: "x_image", payload: { text: "pic", image_path: IMG } });
  });

  it("stages a video post with a tenant-owned path", async () => {
    const emit = vi.fn().mockResolvedValue("dec-xv");
    await socialProposePostTool.execute(ctx(emit), { channel: "x_video", text: "clip", video_path: VID, rationale: "r" });
    expect(emit.mock.calls[0][1]).toMatchObject({ channel: "x_video", payload: { text: "clip", video_path: VID } });
  });

  it("refuses another tenant's path and a URL", async () => {
    await expectRefusal(
      { channel: "x_image", text: "t", image_path: `${OTHER}/9f9f9f9f-0000-4000-8000-000000000000.jpg`, rationale: "r" },
      "social_propose_image_not_owned",
    );
    await expectRefusal({ channel: "x_video", text: "t", video_path: "https://evil.example/v.mp4", rationale: "r" }, "social_propose_image_not_owned");
  });
});

describe("social__propose_post — pinterest_pin publication readiness", () => {
  const PIN = {
    channel: "pinterest_pin",
    text: "Stonewashed linen.",
    title: "Linen duvet cover",
    image_path: IMG,
    board_id: "222",
    board_name: "Board A",
    link: "https://acme.com/p/duvet",
    rationale: "r",
  };
  const pass = { status: "pass" };
  const ready = (over: Record<string, unknown> = {}) => ({
    ok: true,
    checked_at: "2026-10-08T00:00:00.000Z",
    checks: { board: pass, media: pass, link: pass, identity: pass },
    board: { id: "222", name: "Board B", privacy: "PUBLIC" },
    board_count: 3,
    ...over,
  });

  beforeEach(() => {
    findBoard.mockResolvedValue({ id: "222", name: "Board B" });
  });

  it("checks board, image and link for THIS tenant, names the board from the account and stores the result on the card", async () => {
    readiness.mockResolvedValue(ready());
    const emit = vi.fn().mockResolvedValue("dec-pin");
    await socialProposePostTool.execute(ctx(emit), PIN);
    expect(readiness).toHaveBeenCalledWith(TENANT, { board_id: "222", image_path: IMG, link: "https://acme.com/p/duvet" });
    expect(emit).toHaveBeenCalledOnce();
    const body = emit.mock.calls[0][1];
    expect(body).toMatchObject({ channel: "pinterest_pin", payload: { board_id: "222", board_name: "Board B" } });
    expect(body.readiness).toEqual(ready());
  });

  it("a staged pin points at the Pinterest channel page, not Needs you now", async () => {
    readiness.mockResolvedValue(ready());
    const out = (await socialProposePostTool.execute(ctx(), PIN)) as { note: string; publishing_paused: boolean };
    expect(out.note).toBe(
      "Staged for approval. Nothing is live until the operator approves the card on the Pinterest channel page (Growth Channels → Pinterest).",
    );
    expect(out.publishing_paused).toBe(false);
  });

  it("refuses with the founder reason when the link page blocks pins, even though the board exists", async () => {
    readiness.mockResolvedValue(
      ready({
        ok: false,
        checks: { board: pass, media: pass, link: { status: "fail", reason_code: "pinterest_link_nopin", reason: "The page this pin links to tells Pinterest not to allow pins from it." }, identity: pass },
        reason_code: "pinterest_link_nopin",
        reason: "The page this pin links to tells Pinterest not to allow pins from it.",
      }),
    );
    const emit = vi.fn();
    const err = (await socialProposePostTool.execute(ctx(emit), PIN).catch((e: unknown) => e)) as ExpectedToolError;
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err).toMatchObject({ code: "social_propose_pinterest_not_ready", meta: { reason_code: "pinterest_link_nopin" } });
    expect(err.message).toContain("tells Pinterest not to allow pins");
    expect(err.message).not.toContain("board ids");
    expect(emit).not.toHaveBeenCalled();
  });

  it("refuses a board that is not on the account and points at the board ids", async () => {
    readiness.mockResolvedValue(
      ready({
        ok: false,
        board: null,
        checks: { board: { status: "fail", reason_code: "pinterest_board_missing", reason: "That board is not on your connected Pinterest account any more." }, media: pass, link: pass, identity: pass },
        reason_code: "pinterest_board_missing",
        reason: "That board is not on your connected Pinterest account any more.",
      }),
    );
    const emit = vi.fn();
    const err = (await socialProposePostTool.execute(ctx(emit), PIN).catch((e: unknown) => e)) as ExpectedToolError;
    expect(err).toMatchObject({ code: "social_propose_pinterest_not_ready", meta: { reason_code: "pinterest_board_missing" } });
    expect(err.message).toContain("board ids");
    expect(emit).not.toHaveBeenCalled();
  });

  it("an unverified site identity does not refuse; the card carries it", async () => {
    readiness.mockResolvedValue(ready({ checks: { board: pass, media: pass, link: pass, identity: { status: "unverified", reason: "Your company website is not on file." } } }));
    const emit = vi.fn().mockResolvedValue("dec-pin");
    await socialProposePostTool.execute(ctx(emit), PIN);
    expect(emit.mock.calls[0][1].readiness.checks.identity.status).toBe("unverified");
  });

  it("never runs the Pinterest checks for another channel", async () => {
    const emit = vi.fn().mockResolvedValue("dec-li");
    await socialProposePostTool.execute(ctx(emit), { channel: "linkedin", text: "hi", rationale: "r" });
    expect(readiness).not.toHaveBeenCalled();
    expect(emit.mock.calls[0][1]).not.toHaveProperty("readiness");
  });
});

it("stages every post in a requested batch without publishing any of them", async () => {
  const emit = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second").mockResolvedValueOnce("third");
  const texts = ["First finished post.", "Second finished post.", "Third finished post."];
  const outputs = [];
  for (const text of texts) outputs.push(await socialProposePostTool.execute(ctx(emit), {channel:"linkedin",text,rationale:"Requested batch"}));
  expect(emit).toHaveBeenCalledTimes(3);
  expect(emit.mock.calls.map(call => call[1].payload.text)).toEqual(texts);
  expect(outputs).toEqual(["first","second","third"].map(id=>expect.objectContaining({decision_id:id,staged:true,published:false})));
});
