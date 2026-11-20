
import { describe, it, expect, vi, beforeEach } from "vitest";
import { xThreadOutcome } from "@zavi/shared";

const m = vi.hoisted(() => ({
  enqueue: vi.fn(),
  target: vi.fn(),
  logEvent: vi.fn(async () => {}),
}));

vi.mock("@/services/slack/outbox", () => ({ enqueueSlackOutbox: m.enqueue }));
vi.mock("@/services/slack/approval-post-target", () => ({ resolveApprovalPostTarget: m.target }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.logEvent }));
vi.mock("@/services/connectors/linkedin-social/publish", () => ({ publishLinkedInText: vi.fn(), publishLinkedInImage: vi.fn() }));
vi.mock("@/services/connectors/x-social/publish", () => ({ publishXText: vi.fn() }));
vi.mock("@/services/connectors/reddit-social/publish", () => ({ publishRedditSelfPost: vi.fn() }));
vi.mock("@/services/connectors/instagram-social/publish", () => ({ publishInstagramImage: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/connectors/pipedream/api", () => ({ runAction: vi.fn() }));
vi.mock("@/services/connectors/social-publish-account", () => ({ verifySocialAccountAtPublish: vi.fn() }));

import { buildSocialResultBody, notifySocialResult, SOCIAL_FAILURE_COPY } from "../social-publish";

const DB_ERROR_CODES = [
  "disconnected",
  "unauthorized_destination",
  "vendor_rejected",
  "transient_exhausted",
  "channel_disabled",
  "snapshot_changed",
  "reconnect_required",
];

const row = { id: "post-1", tenant_id: "t-1", agent_run_id: "run-1", channel: "linkedin" };

beforeEach(() => {
  m.enqueue.mockReset().mockResolvedValue(1);
  m.target.mockReset().mockResolvedValue({ channel: "C123", team_id: "T1" });
  m.logEvent.mockClear();
});

describe("buildSocialResultBody", () => {
  it("warns about an incomplete X thread while keeping the published root link", () => {
    const partialThread = xThreadOutcome({ id: "root", thread_ids: ["second"], thread_error: { index: 1, status: 403 } }, 3);
    const body = buildSocialResultBody({ channel: "x", ok: true, externalUrl: "https://x.com/i/web/status/root", errorCode: null, partialThread });
    expect(body).toContain("Only 2 of 3 posts");
    expect(body).toContain("do not repost the whole thread");
    expect(body).toContain("https://x.com/i/web/status/root");
    expect(body).not.toContain("✅");
  });

  it("does not claim a timed-out tail definitely failed to publish", () => {
    const outcome = xThreadOutcome({ id: "root", thread_ids: [], thread_error: { index: 0, status: 0 } }, 3);
    expect(outcome?.message).toContain("1 of 3 posts in the thread are confirmed published");
    expect(outcome?.message).toContain("could not confirm whether the next post reached X");
  });

  it("does not claim a tail X accepted (2xx, no id) failed to publish", () => {
    const outcome = xThreadOutcome({ id: "root", thread_ids: [], thread_error: { index: 0, status: 201 } }, 3);
    expect(outcome?.message).toContain("could not confirm whether the next post reached X");
  });
  it("does not invent a partial failure or a publication without a root", () => {
    expect(xThreadOutcome({ id: "root", thread_ids: ["second"] }, 2)).toBeNull();
    expect(xThreadOutcome({ thread_error: { index: 0 } }, 2)).toBeNull();
    expect(xThreadOutcome(null)).toBeNull();
  });
  it("a Zavi refusal says why in Zavi's words, not that the platform rejected it", () => {
    const body = buildSocialResultBody({
      channel: "x",
      ok: false,
      externalUrl: null,
      errorCode: "vendor_rejected",
      refusal: 'The post contains the test marker "(Zavi dev)" (in text).',
    });
    expect(body).toContain("test marker");
    expect(body).not.toMatch(/platform rejected/);
  });

  it("success links the live post", () => {
    expect(buildSocialResultBody({ channel: "linkedin", ok: true, externalUrl: "https://li/x", errorCode: null })).toBe(
      "✅ Posted on LinkedIn — <https://li/x|open it ↗>",
    );
    expect(buildSocialResultBody({ channel: "reddit", ok: true, externalUrl: null, errorCode: null })).toBe("✅ Posted on Reddit.");
  });

  it("names Instagram and LinkedIn for a video post, not the raw channel id", () => {
    expect(buildSocialResultBody({ channel: "instagram_video", ok: true, externalUrl: null, errorCode: null })).toBe("✅ Posted on Instagram.");
    expect(buildSocialResultBody({ channel: "linkedin_video", ok: true, externalUrl: null, errorCode: null })).toBe("✅ Posted on LinkedIn.");
  });

  it("names TikTok and X for media posts, not the raw channel id", () => {
    expect(buildSocialResultBody({ channel: "tiktok_video", ok: true, externalUrl: null, errorCode: null })).toBe("✅ Posted on TikTok.");
    expect(buildSocialResultBody({ channel: "x_image", ok: true, externalUrl: null, errorCode: null })).toBe("✅ Posted on X.");
    expect(buildSocialResultBody({ channel: "x_video", ok: true, externalUrl: null, errorCode: null })).toBe("✅ Posted on X.");
  });

  it("has human copy for every DB error code, and each failure body uses it", () => {
    expect(Object.keys(SOCIAL_FAILURE_COPY).sort()).toEqual([...DB_ERROR_CODES].sort());
    for (const code of DB_ERROR_CODES) {
      const body = buildSocialResultBody({ channel: "instagram_image", ok: false, externalUrl: null, errorCode: code });
      expect(body.startsWith("Couldn't publish the Instagram post: ")).toBe(true);
      expect(body).not.toContain("⚠");
      expect(body).toContain(SOCIAL_FAILURE_COPY[code].replace("{app}", "Instagram"));
      expect(body).not.toContain(code);
      expect(body).not.toContain("{app}");
    }
  });

  it("an unknown code degrades to a generic line", () => {
    expect(buildSocialResultBody({ channel: "x", ok: false, externalUrl: null, errorCode: "??" })).toMatch(/something went wrong/);
  });
});

describe("notifySocialResult", () => {
  it("enqueues ONE outbox row keyed by the post id, at the approval target", async () => {
    await notifySocialResult(row, { ok: true, externalUrl: "https://li/x", errorCode: null });
    expect(m.target).toHaveBeenCalledWith("t-1", "run-1");
    expect(m.enqueue).toHaveBeenCalledOnce();
    expect((m.enqueue.mock.calls[0] as unknown[])[0]).toMatchObject({
      tenant_id: "t-1",
      channel_id: "C123",
      team_id: "T1",
      kind: "social_publish_result",
      idempotency_key: "social_publish_result:post-1",
      depends_on_answer: false,
      run_id: "run-1",
    });
  });

  it("no agent run → resolves with an empty hint (decisions may have no run)", async () => {
    await notifySocialResult({ ...row, agent_run_id: null }, { ok: false, externalUrl: null, errorCode: "disconnected" });
    expect(m.target).toHaveBeenCalledWith("t-1", "");
  });

  it("no Slack target → logs, no enqueue, no throw", async () => {
    m.target.mockResolvedValue(null);
    await expect(notifySocialResult(row, { ok: true, externalUrl: null, errorCode: null })).resolves.toBeUndefined();
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.logEvent).toHaveBeenCalledOnce();
    expect((m.logEvent.mock.calls[0] as unknown[])[0]).toMatchObject({ code: "social_publish.result_no_slack_target", tenant_id: "t-1" });
  });

  it("a throwing resolver or enqueue never escapes into the finalize path", async () => {
    m.target.mockRejectedValue(new Error("slack down"));
    await expect(notifySocialResult(row, { ok: true, externalUrl: null, errorCode: null })).resolves.toBeUndefined();
    m.target.mockResolvedValue({ channel: "C1" });
    m.enqueue.mockRejectedValue(new Error("db down"));
    await expect(notifySocialResult(row, { ok: true, externalUrl: null, errorCode: null })).resolves.toBeUndefined();
  });
});
