
import { describe, it, expect, vi } from "vitest";
import {
  maybeSendSteerChannelAlert,
  renderSteerChannelEmail,
  steerAlertBucketKey,
} from "../steer-channel-alert";

const ARGS = {
  run_id: "run-1",
  tenant_id: "tenant-1",
  agent_slug: "operator",
  error: "drain_agent_run_steers: function does not exist",
  consecutive: 3,
};

function sbStub(initialBlob: Record<string, unknown>) {
  const state = { blob: initialBlob, updates: [] as Record<string, unknown>[] };
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { blob: state.blob }, error: null }),
        }),
      }),
      update: (patch: { blob: Record<string, unknown> }) => {
        state.updates.push(patch.blob);
        state.blob = patch.blob;
        return { eq: async () => ({ error: null }) };
      },
    }),
  };
  return { state, client };
}

describe("steer-channel ops alert", () => {
  it("emails ops when the channel degrades, and records the dedupe marker", async () => {
    const { state, client } = sbStub({});
    const sgSend = vi.fn(async () => {});
    await maybeSendSteerChannelAlert(ARGS, {
      sgSend,
      serviceClient: () => client as never,
      now: () => "2026-07-13T01:00:00.000Z",
    });

    expect(sgSend).toHaveBeenCalledTimes(1);
    const [to, subject, , text] = sgSend.mock.calls[0] as unknown as string[];
    expect(to).toBe("ravi@zaviagent.com");
    expect(subject).toMatch(/steer channel is FAILING/i);
    expect(text).toContain("drain_agent_run_steers");
    expect(text).toContain("agent_barge_in_enabled = false");
    expect(state.blob.steer_channel_alert_sent_for).toBe(
      steerAlertBucketKey("2026-07-13T01:00:00.000Z"),
    );
  });

  it("DEDUPE: a second degradation in the same 6h window sends NOTHING", async () => {
    const marker = steerAlertBucketKey("2026-07-13T01:00:00.000Z");
    const { client } = sbStub({ steer_channel_alert_sent_for: marker });
    const sgSend = vi.fn(async () => {});
    await maybeSendSteerChannelAlert(ARGS, {
      sgSend,
      serviceClient: () => client as never,
      now: () => "2026-07-13T02:30:00.000Z",
    });
    expect(sgSend).not.toHaveBeenCalled();
  });

  it("a NEW 6h window alerts again (a still-broken channel must keep nagging)", async () => {
    const oldMarker = steerAlertBucketKey("2026-07-12T01:00:00.000Z");
    const { client } = sbStub({ steer_channel_alert_sent_for: oldMarker });
    const sgSend = vi.fn(async () => {});
    await maybeSendSteerChannelAlert(ARGS, {
      sgSend,
      serviceClient: () => client as never,
      now: () => "2026-07-13T01:00:00.000Z",
    });
    expect(sgSend).toHaveBeenCalledTimes(1);
  });

  it("a failed SEND does not burn the window (marker only written after success)", async () => {
    const { state, client } = sbStub({});
    const sgSend = vi.fn(async () => {
      throw new Error("sendgrid 503");
    });
    await expect(
      maybeSendSteerChannelAlert(ARGS, {
        sgSend,
        serviceClient: () => client as never,
        now: () => "2026-07-13T01:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
    expect(state.blob.steer_channel_alert_sent_for).toBeUndefined();
  });

  it("renders the raw error + run identity so the email is actionable on its own", () => {
    const { subject, text } = renderSteerChannelEmail(ARGS);
    expect(subject).toContain("🚨");
    expect(text).toContain("run=run-1");
    expect(text).toContain("agent=operator");
    expect(text).toContain("3 consecutive drain attempts");
  });
});
