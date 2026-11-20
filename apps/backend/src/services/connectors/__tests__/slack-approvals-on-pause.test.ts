import { beforeEach, describe, expect, it, vi } from "vitest";

let run: Record<string, unknown> | null = null;
let readError: { message: string } | null = null;
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: run, error: readError }) };
    return { from: () => q };
  },
}));
const post = vi.fn(async () => ({ posted: 1, failed: 0 }));
vi.mock("../../../../workers/functions/approval-slack-notify", () => ({ postPendingApprovalBubblesForRun: (...a: unknown[]) => post(...(a as [])) }));

import { postSlackApprovalsOnPause } from "../chat-approval-notify";

const slackRun = { trigger: "slack", enqueued_by: null, payload: { slack: { channel_id: "D0B448H4PKP", thread_ts: "1729.1", team_id: "T9", user: "U1" } } };

beforeEach(() => {
  post.mockClear();
  run = slackRun;
  readError = null;
});

describe("postSlackApprovalsOnPause", () => {
  it("must-catch: a paused server-created Slack run posts its bubbles into its own thread", async () => {
    expect(await postSlackApprovalsOnPause({ tenant_id: "t1", run_id: "r1" })).toEqual({ posted: 1 });
    expect(post).toHaveBeenCalledWith({ tenant_id: "t1", run_id: "r1", channel_id: "D0B448H4PKP", thread_ts: "1729.1", team_id: "T9" });
  });

  it("must-not-touch: a user-created row, another trigger, no thread, a missing row or a read error posts nothing", async () => {
    for (const r of [{ ...slackRun, enqueued_by: "u1" }, { ...slackRun, trigger: "chat" }, { ...slackRun, payload: { slack: { channel_id: "D1" } } }, null]) {
      run = r;
      expect(await postSlackApprovalsOnPause({ tenant_id: "t1", run_id: "r1" })).toEqual({ posted: 0 });
    }
    run = slackRun;
    readError = { message: "down" };
    expect(await postSlackApprovalsOnPause({ tenant_id: "t1", run_id: "r1" })).toEqual({ posted: 0 });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("postSlackApprovalsOnPause with an older card the run got back", () => {
  it("passes the card ids to the poster", async () => {
    run = slackRun;
    await postSlackApprovalsOnPause({ tenant_id: "t1", run_id: "r1", decision_ids: ["d-old"] });
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ run_id: "r1", decision_ids: ["d-old"], channel_id: "D0B448H4PKP" }));
  });
});
