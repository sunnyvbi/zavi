import { describe, expect, it, vi } from "vitest";

const alertFounderSafely = vi.fn(async (_t: string, _why: string) => undefined);
vi.mock("@/services/growth/cgo-blockers", () => ({ alertFounderSafely: (t: string, why: string) => alertFounderSafely(t, why) }));
import { setChannelActionVideoMedia, settleChannelActionExec } from "../exec-actions";
import { GENERATED_VIDEO_RENDER_CLASS } from "../generated-video-render";
import { MUTATE_NOT_ALLOWED } from "./exec-failure.fixtures";

const REFUSAL = `Google Ads googleAds:mutate failed: 400 {"error":{"status":"INVALID_ARGUMENT","details":[{"errors":[{"errorCode":{"mutateError":"MUTATE_NOT_ALLOWED"}}]}]}}`;
const BLOCKED_NOTE = "Google Ads refused this change, so Zavi closed the card. We've been alerted; nothing for you to do.";
const rpcReturning = (data: Record<string, unknown>) => vi.fn(async () => ({ data, error: null }));
const argsOf = (rpc: { mock: { calls: ReadonlyArray<readonly unknown[]> } }, i = 0) => rpc.mock.calls[i][2] as Record<string, unknown>;

describe("settleChannelActionExec stamps one verdict (the shared invariant)", () => {
  it("blocked: the clean note goes in p_error; the raw error and the verdict stay in p_result; the drainer is nudged once", async () => {
    const rpc = rpcReturning({ ok: true, executed: false });
    const nudge = vi.fn();
    const out = await settleChannelActionExec("t", { actionId: "a", ok: false, error: REFUSAL, result: { error: REFUSAL, code: "google_ads_mutate_failed" }, claimId: "c", execClass: "google_ads.create_campaign" }, rpc as never, nudge);
    expect((rpc.mock.calls[0] as unknown[])[1]).toBe("settle_channel_action_exec");
    expect(argsOf(rpc)).toEqual({
      p_action_id: "a",
      p_ok: false,
      p_result: { error: REFUSAL, code: "google_ads_mutate_failed", bucket: "blocked_on_us", fix: null, platform_code: "MUTATE_NOT_ALLOWED" },
      p_error: BLOCKED_NOTE,
      p_claim_id: "c",
    });
    expect(out).toEqual({ ok: true, code: undefined, replayed: false });
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it("a replayed or refused blocked settle does not nudge", async () => {
    const nudge = vi.fn();
    await settleChannelActionExec("t", { actionId: "a", ok: false, error: REFUSAL, result: { error: REFUSAL }, claimId: "c", execClass: "google_ads.create_campaign" }, rpcReturning({ ok: true, replayed: true }) as never, nudge);
    await settleChannelActionExec("t", { actionId: "a", ok: false, error: REFUSAL, result: { error: REFUSAL }, claimId: "c", execClass: "google_ads.create_campaign" }, rpcReturning({ ok: false, code: "not_dispatching" }) as never, nudge);
    expect(nudge).not.toHaveBeenCalled();
  });

  it("temporary keeps the raw note and no nudge; a founder hold gets no verdict; a success is untouched", async () => {
    const rpc = rpcReturning({ ok: true });
    const nudge = vi.fn();
    await settleChannelActionExec("t", { actionId: "a", ok: false, error: "socket hang up", result: { error: "socket hang up" }, execClass: "meta_ads.set_status" }, rpc as never, nudge);
    expect(argsOf(rpc, 0)).toMatchObject({ p_result: { error: "socket hang up", bucket: "temporary", fix: null, platform_code: null }, p_error: "socket hang up", p_claim_id: null });
    await settleChannelActionExec("t", { actionId: "a", ok: false, error: "held", result: { error: "held", held_for_founder: true }, execClass: "meta_ads.set_status" }, rpc as never, nudge);
    expect(argsOf(rpc, 1)).toMatchObject({ p_result: { error: "held", held_for_founder: true }, p_error: "held" });
    await settleChannelActionExec("t", { actionId: "a", ok: true, result: { notice: "n" }, error: "n", execClass: "meta_ads.set_status" }, rpc as never, nudge);
    expect(argsOf(rpc, 2)).toMatchObject({ p_result: { notice: "n" }, p_error: "n" });
    expect(nudge).not.toHaveBeenCalled();
  });

  it("a landed ad failure tells the founder directly, with no cgo run (cgo-blockers decides if money is at risk)", async () => {
    alertFounderSafely.mockClear();
    const reconnect = `Meta Graph error: {"error":{"code":190,"type":"OAuthException"}}`;
    await settleChannelActionExec("t", { actionId: "a1", ok: false, error: reconnect, result: { error: reconnect, code: "meta_ads_token_expired" }, claimId: "c1", execClass: "meta_ads.update_ad_set_budget" }, rpcReturning({ ok: true }) as never, vi.fn());
    await settleChannelActionExec("t", { actionId: "a3", ok: false, error: "x", result: { interrupted: true, lease_expired: true, code: "exec_outcome_unknown" }, claimId: null, execClass: "meta_ads.duplicate_ad_set" }, rpcReturning({ ok: true }) as never, vi.fn());
    expect(alertFounderSafely.mock.calls).toEqual([["t", "failed ad change"], ["t", "failed ad change"]]);
  });

  it("a refusal because the founder stopped the channel: no verdict, no nudge, no alert (Growth J6)", async () => {
    alertFounderSafely.mockClear();
    const rpc = rpcReturning({ ok: true, executed: false });
    const nudge = vi.fn();
    await settleChannelActionExec("t", { actionId: "a", ok: false, error: "You stopped this channel", result: { code: "founder_stopped" }, claimId: "c", execClass: "meta_ads.update_ad_set_budget" }, rpc as never, nudge);
    expect(argsOf(rpc)).toMatchObject({ p_result: { code: "founder_stopped" }, p_error: "You stopped this channel" });
    expect(argsOf(rpc).p_result).not.toHaveProperty("bucket");
    expect(nudge).not.toHaveBeenCalled();
    expect(alertFounderSafely).not.toHaveBeenCalled();
  });

  it("no alert for a replay, a success, or a change that moves no ad money", async () => {
    alertFounderSafely.mockClear();
    await settleChannelActionExec("t", { actionId: "a", ok: false, error: "socket hang up", result: { error: "socket hang up" }, claimId: "c", execClass: "meta_ads.set_status" }, rpcReturning({ ok: true, replayed: true }) as never, vi.fn());
    await settleChannelActionExec("t", { actionId: "a", ok: true, result: {}, claimId: "c", execClass: "meta_ads.set_status" }, rpcReturning({ ok: true }) as never, vi.fn());
    await settleChannelActionExec("t", { actionId: "a", ok: false, error: "socket hang up", result: { error: "socket hang up" }, claimId: "c", execClass: "social.publish.v2" }, rpcReturning({ ok: true }) as never, vi.fn());
    expect(alertFounderSafely).not.toHaveBeenCalled();
  });

  it("the verdict never carries the note into exec_result", async () => {
    const rpc = rpcReturning({ ok: true });
    await settleChannelActionExec("t", { actionId: "a", ok: false, error: MUTATE_NOT_ALLOWED, result: { error: MUTATE_NOT_ALLOWED }, execClass: "google_ads.create_campaign" }, rpc as never, vi.fn());
    expect(argsOf(rpc).p_result).not.toHaveProperty("note");
  });

  it("the worker's own refusals sort from their result shape", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ kill_switch: true, platform: "google_ads" }, "temporary"],
      [{ no_handler: true }, "blocked_on_us"],
      [{ code: "plan_upgrade_required", required_tier: "pro" }, "needs_founder"],
      [{ interrupted: true, lease_expired: true, code: "exec_outcome_unknown" }, "partial_risk"],
    ];
    for (const [result, bucket] of cases) {
      const rpc = rpcReturning({ ok: true });
      await settleChannelActionExec("t", { actionId: "a", ok: false, error: "words", result, execClass: "google_ads.set_status" }, rpc as never, vi.fn());
      expect((argsOf(rpc).p_result as Record<string, unknown>).bucket, JSON.stringify(result)).toBe(bucket);
    }
  });

  it("a missing exec_class (a mutation memoized before the field existed) does not throw", async () => {
    const rpc = rpcReturning({ ok: true });
    await settleChannelActionExec("t", { actionId: "a", ok: false, error: REFUSAL, result: { error: REFUSAL }, execClass: undefined as unknown as string }, rpc as never, vi.fn());
    expect(argsOf(rpc).p_error).toBe("These refused this change, so Zavi closed the card. We've been alerted; nothing for you to do.");
  });

  it("throws on an RPC error, so the settle step retries", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
    await expect(settleChannelActionExec("t", { actionId: "a", ok: false, error: "x", execClass: "meta_ads.set_status" }, rpc as never, vi.fn())).rejects.toThrow(/boom/);
  });
});

describe("setChannelActionVideoMedia sorts a failed render", () => {
  it.each([
    ["insufficient_credits", "Not enough credits", "needs_founder", "credits"],
    ["render_timeout", "render timed out", "temporary", null],
    ["exec_outcome_unknown", "may exist", "partial_risk", null],
    [null, `Google Ads googleAds:mutate failed: 400 {"error":{"status":"INVALID_ARGUMENT"}}`, "blocked_on_us", null],
  ])("code %s → %s via p_verdict; p_error stays the worker's words", async (code, error, bucket, fix) => {
    const rpc = rpcReturning({ ok: true });
    await setChannelActionVideoMedia("t", { actionId: "a", runId: "r", claimId: "c", ok: false, error, code }, rpc as never, vi.fn());
    expect(argsOf(rpc)).toMatchObject({ p_error: error, p_code: code, p_verdict: { bucket, fix } });
  });

  it("a success carries no verdict; a landed blocked failure nudges once", async () => {
    const rpc = rpcReturning({ ok: true });
    const nudge = vi.fn();
    await setChannelActionVideoMedia("t", { actionId: "a", runId: "r", claimId: "c", ok: true, media: { kind: "video" } }, rpc as never, nudge);
    expect(argsOf(rpc).p_verdict).toBeNull();
    await setChannelActionVideoMedia("t", { actionId: "a", runId: "r", claimId: "c", ok: false, error: "No handler is registered for x." }, rpc as never, nudge);
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it("names the platform AI UGC Videos (the render class is the one this module pins)", async () => {
    expect(GENERATED_VIDEO_RENDER_CLASS).toBe("generated_video.render.v1");
    const rpc = rpcReturning({ ok: true });
    await setChannelActionVideoMedia("t", { actionId: "a", runId: "r", claimId: "c", ok: false, error: "failed: 400 x" }, rpc as never, vi.fn());
    expect(argsOf(rpc).p_verdict).toMatchObject({ bucket: "blocked_on_us", note: "AI UGC Videos refused this change, so Zavi closed the card. We've been alerted; nothing for you to do." });
  });
});
