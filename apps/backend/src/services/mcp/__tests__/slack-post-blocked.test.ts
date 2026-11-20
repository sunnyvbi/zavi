
import { describe, it, expect, vi, beforeEach } from "vitest";

const callSlackTool = vi.fn(async () => ({
  ok: true,
  is_error: false,
  content: "{}",
  ms: 1,
}));

vi.mock("../internal/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../internal/slack")>()),
  callSlackTool: (...a: unknown[]) => callSlackTool(...(a as [])),
}));
vi.mock("../tool-effect-ledger", () => ({
  isToolEffectLedgerEnabled: () => false,
  runWithToolEffectGuard: vi.fn(),
}));
vi.mock("../governance-enforce", () => ({
  governActionOrBlock: async () => ({ block: false }),
}));

import { callMcpTool } from "../execute";

const TENANT = "00000000-0000-0000-0000-0000000000aa";

beforeEach(() => {
  callSlackTool.mockClear();
});

describe("callMcpTool slack — inbound source-unverified block (Slice 3)", () => {
  it("REFUSES the post (error result) and never calls callSlackTool when slack_post_blocked", async () => {
    const r = await callMcpTool(
      { tenant_id: TENANT, run_id: "r1", slack_post_blocked: true },
      "slack",
      "post_message",
      { channel_id: "C1", text: "hi" },
    );
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("slack_workspace_unresolved");
    expect(callSlackTool).not.toHaveBeenCalled();
  });

  it("REFUSES a DM (user_id) on a blocked run — never opens or posts", async () => {
    const r = await callMcpTool(
      { tenant_id: TENANT, run_id: "rd", slack_post_blocked: true },
      "slack",
      "post_message",
      { user_id: "U0BZ07V1RKR", text: "hi" },
    );
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("slack_workspace_unresolved");
    expect(callSlackTool).not.toHaveBeenCalled();
  });

  it("REFUSES slack_open_dm on a blocked run", async () => {
    const r = await callMcpTool(
      { tenant_id: TENANT, run_id: "ro", slack_post_blocked: true },
      "slack",
      "open_dm",
      { user_ids: ["U1"] },
    );
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("slack_workspace_unresolved");
    expect(callSlackTool).not.toHaveBeenCalled();
  });

  it("posts with the resolved target team_id when NOT blocked", async () => {
    await callMcpTool(
      { tenant_id: TENANT, run_id: "r2", slack_target_team_id: "TDEV" },
      "slack",
      "post_message",
      { channel_id: "C1", text: "hi" },
    );
    expect(callSlackTool).toHaveBeenCalledWith(
      TENANT,
      "post_message",
      { channel_id: "C1", text: "hi" },
      "TDEV",
      undefined,
      "r2",
    );
  });

  it("does NOT fall back to slack_routing.team_id (fail-closed) — passes undefined when no target resolved", async () => {
    await callMcpTool(
      {
        tenant_id: TENANT,
        run_id: "r3",
        slack_routing: {
          channel_id: "C1",
          thread_ts: "1",
          original_ts: "1",
          event_id: "E1",
          team_id: "TSOURCE",
        },
      },
      "slack",
      "post_message",
      { channel_id: "C1", text: "hi" },
    );
    expect(callSlackTool).toHaveBeenCalledWith(
      TENANT,
      "post_message",
      { channel_id: "C1", text: "hi" },
      undefined,
      undefined,
      "r3",
    );
  });
});
