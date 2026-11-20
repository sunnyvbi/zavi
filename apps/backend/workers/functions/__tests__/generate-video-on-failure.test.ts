import { describe, it, expect, vi, beforeEach } from "vitest";

const deliveryMocks = vi.hoisted(() => ({ callSlackTool: vi.fn(), deliverArtifactToThread: vi.fn() }));

vi.mock("@/services/media-router/router", () => ({
  isMediaRouterEnabled: vi.fn(),
  submitMedia: vi.fn(),
  pollMediaOnce: vi.fn(),
  cancelMedia: vi.fn(),
  generateMedia: vi.fn(),
  estimateCost: vi.fn(),
  costForJob: vi.fn(),
  downloadMedia: vi.fn(),
}));
vi.mock("@/services/media-router/charge", () => ({ canAffordMedia: vi.fn(), checkAffordMedia: vi.fn(), flushCharges: vi.fn() }));
vi.mock("@/services/mcp/higgsfield-meter", () => ({ meterPlatformGeneration: vi.fn() }));
vi.mock("@/services/launch-video/platform-higgsfield", () => ({
  submitGeneration: vi.fn(),
  pollGenerationOnce: vi.fn(),
  generatePlatformImage: vi.fn(),
  isPlatformHiggsfieldConfigured: vi.fn(() => true),
}));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/tools/slack/upload_file", () => ({ uploadFileToThread: vi.fn() }));
vi.mock("@/services/mcp/internal/slack", () => ({ callSlackTool: deliveryMocks.callSlackTool }));
vi.mock("@/services/agents/deliver-artifact-to-thread", () => ({ deliverArtifactToThread: deliveryMocks.deliverArtifactToThread }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/launch-video/finish-pass", () => ({ runFinishPass: vi.fn() }));
vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn() }));

import { notifyGenerateVideoFailure } from "../generate-video";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function makeSb(tables: Tables, failing: string[] = []) {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      like: (k: string, pattern: string) => {
        const prefix = pattern.replace(/%$/, "");
        filters.push((r) => typeof r[k] === "string" && (r[k] as string).startsWith(prefix));
        return q;
      },
      contains: (k: string, sub: Row) => {
        filters.push((r) => Object.entries(sub).every(([sk, sv]) => (r[k] as Row | undefined)?.[sk] === sv));
        return q;
      },
      limit: async () => result(),
      maybeSingle: async () => {
        const r = result();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      update: (patch: Row) => {
        const u = {
          eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), u),
          then: (res: (v: { error: unknown }) => unknown) => {
            if (failing.includes(table)) return Promise.resolve({ error: { message: `${table} down` } }).then(res);
            for (const r of tables[table] ?? []) if (filters.every((f) => f(r))) Object.assign(r, patch);
            return Promise.resolve({ error: null }).then(res);
          },
        };
        return u;
      },
    };
    const result = () =>
      failing.includes(table)
        ? { data: null, error: { message: `${table} down` } }
        : { data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null };
    return q;
  };
  return { from } as never;
}

const RUN = "run-1";
const TENANT = "tenant-1";
const THREAD = "thread-1";
const chat = { run_id: RUN, delivery_target: { kind: "chat" as const, thread_id: THREAD } };
const base = (): Tables => ({
  agent_runs: [{ id: RUN, tenant_id: TENANT }],
  run_artifacts: [],
  agent_thread_messages: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  deliveryMocks.deliverArtifactToThread.mockResolvedValue(true);
});

describe("notifyGenerateVideoFailure", () => {
  it("tells the chat thread when the render died without a word", async () => {
    await notifyGenerateVideoFailure(chat, makeSb(base()));
    expect(deliveryMocks.deliverArtifactToThread).toHaveBeenCalledTimes(1);
    const call = deliveryMocks.deliverArtifactToThread.mock.calls[0][0];
    expect(call).toMatchObject({ tenant_id: TENANT, thread_id: THREAD, run_id: RUN });
    expect(call.body).toMatch(/didn't complete/);
  });

  it("uses the tenant from agent_runs, never one from the event", async () => {
    await notifyGenerateVideoFailure({ ...chat, tenant_id: "attacker" } as never, makeSb(base()));
    expect(deliveryMocks.deliverArtifactToThread.mock.calls[0][0].tenant_id).toBe(TENANT);
  });

  it("stays quiet when the video was delivered", async () => {
    const t = base();
    t.run_artifacts.push({ tenant_id: TENANT, run_id: RUN, mime: "video/mp4" });
    await notifyGenerateVideoFailure(chat, makeSb(t));
    expect(deliveryMocks.deliverArtifactToThread).not.toHaveBeenCalled();
  });

  it("stays quiet when the thread already heard about this run", async () => {
    const t = base();
    t.agent_thread_messages.push({ tenant_id: TENANT, thread_id: THREAD, meta: { source_run_id: RUN, kind: "generative_video_failed" } });
    await notifyGenerateVideoFailure(chat, makeSb(t));
    expect(deliveryMocks.deliverArtifactToThread).not.toHaveBeenCalled();
  });

  it("still posts when another run's message is in the thread", async () => {
    const t = base();
    t.agent_thread_messages.push({ tenant_id: TENANT, thread_id: THREAD, meta: { source_run_id: "other-run" } });
    await notifyGenerateVideoFailure(chat, makeSb(t));
    expect(deliveryMocks.deliverArtifactToThread).toHaveBeenCalledTimes(1);
  });

  it("still tells Slack when the artifact row exists but the upload never landed", async () => {
    const t = base();
    t.run_artifacts.push({ tenant_id: TENANT, run_id: RUN, mime: "video/mp4", slack_delivered: false });
    await notifyGenerateVideoFailure({ run_id: RUN, channel_id: "C1", thread_ts: "1.2" }, makeSb(t));
    expect(deliveryMocks.callSlackTool).toHaveBeenCalledTimes(1);
  });

  it("stays quiet on Slack once the upload is marked delivered", async () => {
    const t = base();
    t.run_artifacts.push({ tenant_id: TENANT, run_id: RUN, mime: "video/mp4", slack_delivered: true });
    await notifyGenerateVideoFailure({ run_id: RUN, channel_id: "C1", thread_ts: "1.2" }, makeSb(t));
    expect(deliveryMocks.callSlackTool).not.toHaveBeenCalled();
  });

  it("posts to Slack for a Slack render", async () => {
    await notifyGenerateVideoFailure({ run_id: RUN, channel_id: "C1", thread_ts: "1.2" }, makeSb(base()));
    expect(deliveryMocks.callSlackTool).toHaveBeenCalledWith(
      TENANT,
      "post_message",
      expect.objectContaining({ channel_id: "C1", thread_ts: "1.2" }),
      undefined,
    );
  });

  it("does nothing for an unknown run or a card target", async () => {
    await notifyGenerateVideoFailure({ ...chat, run_id: "missing" }, makeSb(base()));
    await notifyGenerateVideoFailure(
      { run_id: RUN, delivery_target: { kind: "channel_action", action_id: "a", claim_id: "c" } },
      makeSb(base()),
    );
    expect(deliveryMocks.deliverArtifactToThread).not.toHaveBeenCalled();
    expect(deliveryMocks.callSlackTool).not.toHaveBeenCalled();
  });

  it("throws when the chat delivery fails, so Inngest retries instead of leaving the thread stuck", async () => {
    deliveryMocks.deliverArtifactToThread.mockResolvedValue(false);
    await expect(notifyGenerateVideoFailure(chat, makeSb(base()))).rejects.toThrow(/chat delivery failed/);
  });

  describe("the wallet hold of a render that ran out of retries", () => {
    const withHold = (extra: Row[] = []): Tables => ({
      ...base(),
      generative_video_jobs: [
        { tenant_id: TENANT, run_id: RUN, meter_key: `${RUN}:video-hold`, model: "video-hold", job_id: JSON.stringify({ usd: 2.29 }), status: "pending" },
        { tenant_id: TENANT, run_id: "other-run", meter_key: "other-run:video-hold", model: "video-hold", job_id: JSON.stringify({ usd: 2.29 }), status: "pending" },
        ...extra,
      ],
    });
    const hold = (t: Tables, run = RUN) => t.generative_video_jobs.find((r) => r.meter_key === `${run}:video-hold`);

    it.each([
      ["a chat render", chat],
      ["a Slack render", { run_id: RUN, channel_id: "C1", thread_ts: "1.2" }],
    ])("is released for %s, and no other run's hold is touched", async (_name, data) => {
      const t = withHold();
      await notifyGenerateVideoFailure(data, makeSb(t));
      expect(hold(t)?.status).toBe("completed");
      expect(hold(t, "other-run")?.status).toBe("pending");
    });

    it("is released even when the thread already heard about the failure", async () => {
      const t = withHold();
      t.agent_thread_messages.push({ tenant_id: TENANT, thread_id: THREAD, meta: { source_run_id: RUN, kind: "generative_video_failed" } });
      await notifyGenerateVideoFailure(chat, makeSb(t));
      expect(deliveryMocks.deliverArtifactToThread).not.toHaveBeenCalled();
      expect(hold(t)?.status).toBe("completed");
    });

    it("stays held while the made video still owes its charge", async () => {
      const t = withHold([{ tenant_id: TENANT, run_id: RUN, meter_key: `${RUN}:gen-video:0`, status: "failed", pending_charges: [{ key: `${RUN}:gen-video:0` }] }]);
      await notifyGenerateVideoFailure(chat, makeSb(t));
      expect(hold(t)?.status).toBe("pending");
    });

    it("throws when the release cannot be written, so Inngest retries the handler", async () => {
      await expect(notifyGenerateVideoFailure(chat, makeSb(withHold(), ["generative_video_jobs"]))).rejects.toThrow(/video hold/);
    });
  });

  it("throws on a failed read so Inngest retries the handler", async () => {
    await expect(notifyGenerateVideoFailure(chat, makeSb(base(), ["run_artifacts"]))).rejects.toThrow(/run_artifacts/);
    expect(deliveryMocks.deliverArtifactToThread).not.toHaveBeenCalled();
  });
});
