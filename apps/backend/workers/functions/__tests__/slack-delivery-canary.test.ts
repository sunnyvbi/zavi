
import { describe, it, expect, vi, beforeEach } from "vitest";

type AlertArg = { msg: string; source: string; code?: string; email?: { dedupeKey: string } };
const alertMock = vi.hoisted(() => vi.fn(async (_input: unknown) => {}));
vi.mock("@/services/logging/alert", () => ({ alert: alertMock }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/tools/slack/_client", () => ({ slackFetch: vi.fn() }));

import { runSyntheticSlackCanary, type ConfigLoad } from "../slack-delivery-canary";

const LOADED: ConfigLoad = {
  kind: "ok",
  config: { tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204", channel_id: "C_PROBE" },
};
const noSleep = async () => {};

beforeEach(() => {
  alertMock.mockClear();
});

describe("runSyntheticSlackCanary", () => {
  it("is INERT and silent when unconfigured (safe to merge before the channel exists)", async () => {
    const r = await runSyntheticSlackCanary({ load: { kind: "unconfigured" } });
    expect(r).toEqual({ configured: false, posted: false, read_back: false, ok: true });
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("BLIND: a config READ ERROR pages — never reports green while it can't see", async () => {
    const r = await runSyntheticSlackCanary({
      load: { kind: "read_error", message: "db unreachable" },
    });
    expect(r.ok).toBe(false);
    expect(r.failure_reason).toBe("config_unreadable");
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect((alertMock.mock.calls[0]?.[0] as AlertArg).code).toBe("canary_config_unreadable");
  });

  it("healthy path: posts, reads its nonce back, and stays SILENT", async () => {
    const nonce = "zavi-canary-abc";
    const r = await runSyntheticSlackCanary({
      load: LOADED,
      nonce,
      sleep: noSleep,
      post: (async () => ({ ok: true, ts: "1.2" })) as never,
      read: (async () => ({ messages: [{ text: `hello ${nonce}` }] })) as never,
    });
    expect(r.ok).toBe(true);
    expect(r.read_back).toBe(true);
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("THE SILENT DROP: posts ok but the nonce is NOT in history → pages", async () => {
    const r = await runSyntheticSlackCanary({
      load: LOADED,
      nonce: "zavi-canary-xyz",
      sleep: noSleep,
      post: (async () => ({ ok: true, ts: "1.2" })) as never,
      read: (async () => ({ messages: [{ text: "somebody else's message" }] })) as never,
    });
    expect(r.ok).toBe(false);
    expect(r.posted).toBe(true);
    expect(r.read_back).toBe(false);
    expect(r.failure_reason).toBe("nonce_not_readable");
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0]?.[0]).toMatchObject({
      code: "slack_canary_failed",
      email: expect.objectContaining({ dedupeKey: expect.stringContaining("slack_canary:") }),
    });
  });

  it("token revoked → pages with a C14-safe error CLASS, never the raw message", async () => {
    const r = await runSyntheticSlackCanary({
      load: LOADED,
      sleep: noSleep,
      post: (async () => {
        throw new Error("token_revoked: xoxb-SECRET-LEAKED-HERE");
      }) as never,
    });
    expect(r.ok).toBe(false);
    expect(r.failure_reason).toBe("post_failed:token_revoked");
    const msg = (alertMock.mock.calls[0]?.[0] as AlertArg).msg;
    expect(msg).toContain("token_revoked");
    expect(msg).not.toContain("xoxb-SECRET-LEAKED-HERE");
  });

  it("post returns ok but no ts → pages (a post with no ts never landed)", async () => {
    const r = await runSyntheticSlackCanary({
      load: LOADED,
      sleep: noSleep,
      post: (async () => ({ ok: true })) as never,
    });
    expect(r.ok).toBe(false);
    expect(r.failure_reason).toBe("post_no_ts");
    expect(alertMock).toHaveBeenCalledTimes(1);
  });

  it("post throws but the nonce DID land → unverified page, never a delivery-outage claim", async () => {
    const nonce = "zavi-canary-landed";
    const r = await runSyntheticSlackCanary({
      load: LOADED,
      nonce,
      sleep: noSleep,
      post: (async () => {
        throw Object.assign(new Error("Slack API chat.postMessage timed out after 10000ms"), {
          code: "slack_timeout",
        });
      }) as never,
      read: (async () => ({ messages: [{ text: `${nonce}` }] })) as never,
    });
    expect(r.failure_reason).toBe("post_response_lost:slack_timeout");
    expect(r.posted).toBe(true);
    expect(alertMock).toHaveBeenCalledTimes(1);
    const a = alertMock.mock.calls[0]?.[0] as AlertArg;
    expect(a.code).toBe("slack_canary_unverified");
    expect(a.msg).not.toContain("NOT being delivered");
    expect(a.email?.dedupeKey).toContain("slack_canary_unverified:");
  });

  it("post throws AND the confirm-read throws → UNKNOWN, still not a delivery-outage claim", async () => {
    const r = await runSyntheticSlackCanary({
      load: LOADED,
      sleep: noSleep,
      post: (async () => {
        throw Object.assign(new Error("boom"), { code: "slack_timeout" });
      }) as never,
      read: (async () => {
        throw new Error("also broken");
      }) as never,
    });
    expect(r.failure_reason).toBe("post_unconfirmed:slack_timeout");
    expect((alertMock.mock.calls[0]?.[0] as AlertArg).code).toBe("slack_canary_unverified");
  });

  it("post throws and the nonce is provably ABSENT → the loud delivery-broken page", async () => {
    const r = await runSyntheticSlackCanary({
      load: LOADED,
      nonce: "zavi-canary-gone",
      sleep: noSleep,
      post: (async () => {
        throw Object.assign(new Error("nope"), {
          code: "slack_api_error",
          meta: { slack_error: "channel_not_found" },
        });
      }) as never,
      read: (async () => ({ messages: [{ text: "unrelated" }] })) as never,
    });
    expect(r.failure_reason).toBe("post_failed:channel_not_found");
    expect((alertMock.mock.calls[0]?.[0] as AlertArg).code).toBe("slack_canary_failed");
  });

  it("classifies from ExpectedToolError.code/.meta — the bug that made every page say unknown_error", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ code: "slack_timeout" }, "slack_timeout"],
      [{ code: "slack_http", meta: { status: 429 } }, "http_429"],
      [{ code: "slack_http", meta: { status: 503 } }, "http_503"],
      [{ code: "slack_not_connected" }, "slack_not_connected"],
      [{ code: "slack_api_error", meta: { slack_error: "not_in_channel" } }, "not_in_channel"],
    ];
    for (const [shape, expected] of cases) {
      alertMock.mockClear();
      const r = await runSyntheticSlackCanary({
        load: LOADED,
        sleep: noSleep,
        post: (async () => ({ ok: true, ts: "1.2" })) as never,
        read: (async () => {
          throw Object.assign(new Error("Slack API conversations.history failed"), shape);
        }) as never,
      });
      expect(r.failure_reason).toBe(`readback_failed:${expected}`);
    }
  });

  it("readback throws (bot kicked from channel) → pages", async () => {
    const r = await runSyntheticSlackCanary({
      load: LOADED,
      sleep: noSleep,
      post: (async () => ({ ok: true, ts: "1.2" })) as never,
      read: (async () => {
        throw new Error("not_in_channel");
      }) as never,
    });
    expect(r.ok).toBe(false);
    expect(r.failure_reason).toBe("readback_failed:not_in_channel");
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect((alertMock.mock.calls[0]?.[0] as AlertArg).code).toBe("slack_canary_unverified");
  });
});
