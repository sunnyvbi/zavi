import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));

import { dispatchFailureMessage, failureMessage, refusalMessage, watchSocialPost, type AttemptReason, type DecisionRow, type PostRow, type WatchDeps } from "../socialPostWatch";

function deps(
  rows: Array<PostRow | null | Error>,
  reason: AttemptReason | null = null,
  decision: DecisionRow | null = null,
): WatchDeps & { slept: number[] } {
  let t = 0;
  let i = 0;
  const slept: number[] = [];
  return {
    slept,
    readPost: vi.fn(async () => {
      const r = rows[Math.min(i, rows.length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      return r;
    }),
    readDecision: vi.fn(async () => decision),
    readReason: vi.fn(async () => reason),
    sleep: vi.fn(async (ms: number) => {
      slept.push(ms);
      t += ms;
    }),
    now: () => t,
  };
}

const row = (status: string, over: Partial<PostRow> = {}): PostRow => ({ id: "p1", status, last_error: null, external_url: null, scheduled_at: null, ...over });

describe("watchSocialPost", () => {
  it("waits through approved and publishing, then reports the live pin with its link", async () => {
    const d = deps([null, row("approved"), row("publishing"), row("published", { external_url: "https://www.pinterest.com/pin/123/" })]);
    expect(await watchSocialPost("d1", d, { intervalMs: 2000 })).toEqual({ state: "posted", url: "https://www.pinterest.com/pin/123/" });
    expect(d.slept).toEqual([2000, 2000, 2000]);
    expect(d.readReason).not.toHaveBeenCalled();
  });

  it("a failed post says why in words, reading the attempt's own reason for that post", async () => {
    const d = deps([row("failed", { last_error: "vendor_rejected" })], { code: null, message: "pinterest_pin: media prop is not a signed https URL" });
    expect(await watchSocialPost("d1", d)).toEqual({
      state: "failed",
      message: "Zavi couldn't make a public link to the image, so nothing was sent to Pinterest.",
    });
    expect(d.readReason).toHaveBeenCalledWith("p1");
  });

  it("a cancelled post is reported, never as posted", async () => {
    expect(await watchSocialPost("d1", deps([row("cancelled")]))).toEqual({ state: "failed", message: "The post was cancelled before it went out." });
  });

  it("reports a dispatch refusal that happened before a social post row existed", async () => {
    const d = deps([null], null, {
      status: "dispatch_failed",
      dispatch_error: "Social publishing isn't enabled for your account yet.",
    });
    expect(await watchSocialPost("d1", d)).toEqual({
      state: "failed",
      message: "Social publishing isn't enabled for this workspace yet. Nothing was sent to Pinterest.",
    });
    expect(d.readDecision).toHaveBeenCalledWith("d1");
    expect(d.slept).toEqual([]);
  });

  it("re-reads the post after terminal dispatch failure before claiming nothing was sent", async () => {
    const d = deps([null, row("scheduled", { scheduled_at: "2099-01-02T09:30:00.000Z" })], null, {
      status: "dispatch_failed",
      dispatch_error: "enqueue acknowledgement lost",
    });
    expect(await watchSocialPost("d1", d)).toEqual({
      state: "uncertain",
      message: "Zavi could not confirm whether Pinterest publishing was queued. Do not create another pin; check Pinterest before trying again.",
    });
    expect(d.readPost).toHaveBeenCalledTimes(2);
  });

  it.each(["approved", "scheduled"])("preserves uncertainty when dispatch fails after a %s post row exists", async (status) => {
    const d = deps([row(status)], null, {
      status: "dispatch_failed",
      dispatch_error: "publish-event enqueue failed: private queue detail",
    });
    expect(await watchSocialPost("d1", d)).toEqual({
      state: "uncertain",
      message: "Zavi could not confirm whether Pinterest publishing was queued. Do not create another pin; check Pinterest before trying again.",
    });
    expect(d.readDecision).toHaveBeenCalledWith("d1");
    expect(d.slept).toEqual([]);
  });

  it("keeps approval explicitly uncertain when the decision is still proposed", async () => {
    expect(await watchSocialPost("d1", deps([null], null, { status: "proposed", dispatch_error: null }))).toEqual({ state: "approval_uncertain" });
  });

  it("does not interpret a failed post read as proof that no post exists", async () => {
    const d = deps([new Error("read failed"), row("published")], null, { status: "dispatch_failed", dispatch_error: "enqueue failed" });
    expect(await watchSocialPost("d1", d)).toEqual({ state: "posted", url: null });
    expect(d.slept).toEqual([2000]);
  });

  it("confirms a future scheduled post without polling until publication", async () => {
    const scheduledAt = "2099-01-02T09:30:00.000Z";
    const d = deps([row("scheduled", { scheduled_at: scheduledAt })], null, { status: "acted", dispatch_error: null });
    expect(await watchSocialPost("d1", d)).toEqual({ state: "scheduled", scheduledAt });
    expect(d.slept).toEqual([]);
  });

  it("does not confirm a future schedule until dispatch reaches acted", async () => {
    const scheduledAt = "2099-01-02T09:30:00.000Z";
    const d = deps(
      [row("scheduled", { scheduled_at: scheduledAt }), row("scheduled", { scheduled_at: scheduledAt })],
      null,
      { status: "dispatching", dispatch_error: null },
    );
    expect(await watchSocialPost("d1", d, { intervalMs: 1000, timeoutMs: 1000 })).toEqual({ state: "slow" });
    expect(d.slept).toEqual([1000]);
  });

  it("a read that throws is retried, not reported as a failure", async () => {
    const d = deps([new Error("network"), row("published")]);
    expect(await watchSocialPost("d1", d)).toEqual({ state: "posted", url: null });
  });

  it("gives up as slow, never as failed, when Pinterest has not answered in time", async () => {
    const d = deps([row("publishing")]);
    expect(await watchSocialPost("d1", d, { intervalMs: 1000, timeoutMs: 5000 })).toEqual({ state: "slow" });
    expect(d.slept).toHaveLength(5);
  });
});

describe("failureMessage", () => {
  it("passes Pinterest's own refusal through, without a doubled period", () => {
    expect(failureMessage("vendor_rejected", "Board not found.")).toBe("Pinterest did not accept it. Board not found.");
  });
  it("uses the code's words when there is no reason, and a plain fallback for an unknown code", () => {
    expect(failureMessage("disconnected", null)).toBe("Pinterest is no longer connected. Reconnect it, then post again.");
    expect(failureMessage("weird", null)).toBe("Something went wrong while posting.");
  });
});

describe("dispatchFailureMessage", () => {
  it("does not expose an unknown internal dispatch error", () => {
    expect(dispatchFailureMessage("social_post_create failed: private db detail")).toBe(
      "Zavi could not start this Pinterest post. Nothing was sent to Pinterest.",
    );
  });

  it("tells the founder to reconnect when the account was disconnected before approve", () => {
    expect(dispatchFailureMessage("no connected Pinterest account — connect Pinterest in Settings first")).toBe(
      "Pinterest is no longer connected. Reconnect it, then post again.",
    );
  });
});

describe("a refusal by Zavi itself is never blamed on the platform", () => {
  it("shows Zavi's own message for its refusal codes, not 'Pinterest did not accept it'", async () => {
    const msg = "Zavi couldn't make a public link to the image, so nothing was sent to the platform. Propose it again.";
    const out = await watchSocialPost("d1", deps([row("failed", { last_error: "vendor_rejected" })], { code: "media_link_not_public", message: msg }));
    expect(out).toEqual({ state: "failed", message: msg });
    expect(JSON.stringify(out)).not.toMatch(/did not accept/);
  });

  it("an account re-check failure says nothing was posted", () => {
    expect(refusalMessage({ code: "account_check_failed", message: "Zavi could not re-check your connected account, so nothing was posted. Propose it again." })).toMatch(/nothing was posted/);
  });

  it("a board made secret after staging is Zavi's refusal at approve time, never blamed on Pinterest", async () => {
    const msg = "That board is secret, so nobody but you would see the pin. Pick a public board, or make this one public on Pinterest.";
    const out = await watchSocialPost("d1", deps([row("failed", { last_error: "vendor_rejected" })], { code: "pinterest_board_secret", message: msg }));
    expect(out).toEqual({ state: "failed", message: msg });
    expect(JSON.stringify(out)).not.toMatch(/did not accept/);
  });

  it("a real platform refusal still says Pinterest did not accept it", async () => {
    const out = await watchSocialPost("d1", deps([row("failed", { last_error: "vendor_rejected" })], { code: "pinterest_api_error", message: "Board not found." }));
    expect(out).toEqual({ state: "failed", message: "Pinterest did not accept it. Board not found." });
  });

  it("an unknown Zavi refusal with no message still says nothing was posted", () => {
    expect(refusalMessage({ code: "publish_refused_blanks", message: null })).toBe("Zavi stopped it before it reached the platform, so nothing was posted.");
    expect(refusalMessage({ code: "vendor_rejected", message: "x" })).toBeNull();
    expect(refusalMessage(null)).toBeNull();
  });
});


describe("Instagram watcher outcomes", () => {
  const options = { platform: "Instagram" };
  it.each([
    ["vendor_rejected", "Instagram did not accept it."],
    ["disconnected", "Instagram is no longer connected. Reconnect it, then post again."],
    ["unauthorized_destination", "The connected account can no longer post to that account."],
    ["reconnect_required", "Reconnect Instagram to publish this post."],
  ])("names the actual platform for %s", async (code, message) => {
    expect(await watchSocialPost("ig", deps([row("failed", { last_error: code })]), options)).toEqual({ state: "failed", message });
  });

  it("a timed-out publish is uncertain, not failed: the post may be live", async () => {
    expect(await watchSocialPost("ig", deps([row("failed", { last_error: "transient_exhausted" })]), options)).toEqual({
      state: "uncertain",
      message: "Zavi could not confirm whether the post reached Instagram. Check Instagram before posting again.",
    });
  });

  it("explains an Instagram media-link failure without naming Pinterest", async () => {
    const d = deps([row("failed", { last_error: "vendor_rejected" })], { code: null, message: "image is not a signed https URL" });
    expect(await watchSocialPost("ig", d, options)).toEqual({ state: "failed", message: "Zavi couldn't make a public link to the image, so nothing was sent to Instagram." });
  });

  it.each([
    ["Social publishing isn't enabled", "Social publishing isn't enabled for this workspace yet. Nothing was sent to Instagram."],
    ["not connected", "Instagram is no longer connected. Reconnect it, then post again."],
    ["upgrade required", "Instagram publishing is not available on this workspace's current plan. Nothing was sent."],
    ["private database detail", "Zavi could not start this Instagram post. Nothing was sent to Instagram."],
  ])("explains pre-enqueue dispatch failure: %s", async (dispatch_error, message) => {
    expect(await watchSocialPost("ig", deps([null], null, { status: "dispatch_failed", dispatch_error }), options)).toEqual({ state: "failed", message });
  });

  it.each([[row("approved")], [null, row("scheduled")]])("keeps an ambiguous Instagram enqueue explicitly uncertain", async (...rows) => {
    const d = deps(rows, null, { status: "dispatch_failed", dispatch_error: "enqueue acknowledgement lost" });
    expect(await watchSocialPost("ig", d, options)).toEqual({ state: "uncertain", message: "Zavi could not confirm whether Instagram publishing was queued. Do not create another post; check Instagram before trying again." });
  });
});


describe("X thread outcomes", () => {
  it("reports a partly published thread with the root link and actual count", async () => {
    const d = deps([row("published", { external_url: "https://x.com/company/status/1", thread: ["Second", "Third"] })], {
      code: null, message: null, response: { id: "1", thread_ids: ["2"], thread_error: { message: "provider refused part 3" } },
    });
    expect(await watchSocialPost("d1", d, { platform: "X" })).toMatchObject({
      state: "partial", url: "https://x.com/company/status/1", publishedParts: 2, totalParts: 3,
      message: expect.stringMatching(/do not repost the whole thread/i),
    });
    expect(d.readReason).toHaveBeenCalledWith("p1");
    expect(d.slept).toEqual([]);
  });

  it("does not announce a complete thread when its publish attempt cannot be read", async () => {
    const d = deps([row("published", { thread: ["Second"] })]);
    expect(await watchSocialPost("d1", d, { platform: "X" })).toMatchObject({ state: "uncertain", message: expect.stringMatching(/thread/) });
  });

  it("keeps a fully published thread as posted", async () => {
    const d = deps([row("published", { thread: ["Second"] })], { code: null, message: null, response: { id: "1", thread_ids: ["2"] } });
    expect(await watchSocialPost("d1", d, { platform: "X" })).toEqual({ state: "posted", url: null });
  });
});
