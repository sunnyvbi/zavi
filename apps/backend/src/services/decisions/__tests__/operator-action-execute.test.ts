import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  claimDecisionMock: vi.fn(),
  markDispatchedMock: vi.fn(),
  releaseClaimMock: vi.fn(),
  jiraCreateIssueMock: vi.fn(),
  linearCreateIssueMock: vi.fn(),
  postMessageExecuteMock: vi.fn(),
  serviceClientMock: vi.fn(),
  checkAutoFireRateCapMock: vi.fn(),
  logEventMock: vi.fn(),
  fleetHaltedMock: vi.fn(),
  logDecisionNotTakenMock: vi.fn(),
}));

vi.mock("../atomic-claim", () => ({
  claimDecision: mocks.claimDecisionMock,
  markDispatched: mocks.markDispatchedMock,
  releaseClaim: mocks.releaseClaimMock,
}));

vi.mock("../auto-fire-rate-cap", () => ({
  checkAutoFireRateCap: mocks.checkAutoFireRateCapMock,
}));

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: mocks.logEventMock,
}));

vi.mock("@/services/mcp/internal/jira", () => ({
  jiraCreateIssue: mocks.jiraCreateIssueMock,
}));

vi.mock("@/services/mcp/internal/linear", () => ({
  linearCreateIssue: mocks.linearCreateIssueMock,
}));

vi.mock("@/services/tools/slack/post_message", () => ({
  postMessageTool: { execute: mocks.postMessageExecuteMock },
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: mocks.serviceClientMock,
}));

vi.mock("@/services/agents/log-decision-not-taken", () => ({
  logDecisionNotTaken: mocks.logDecisionNotTakenMock,
}));

vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: () => mocks.fleetHaltedMock(),
}));

import { executeOperatorAction } from "../operator-action-execute";

let connectorTeamName: string | null = "upcar-team";

beforeEach(() => {
  Object.values(mocks).forEach((m) => (m as ReturnType<typeof vi.fn>).mockReset());
  connectorTeamName = "upcar-team";
  mocks.checkAutoFireRateCapMock.mockResolvedValue({ allowed: true, count: 0, cap: 30 });
  mocks.logEventMock.mockResolvedValue(undefined);
  mocks.logDecisionNotTakenMock.mockResolvedValue(true);
  mocks.fleetHaltedMock.mockResolvedValue(false);
  mocks.serviceClientMock.mockReturnValue({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (table === "connector_metadata") {
                return {
                  data: connectorTeamName ? { team_name: connectorTeamName } : null,
                  error: null,
                };
              }
              return { data: null, error: null };
            },
          }),
          maybeSingle: async () => {
            if (table === "agent_runs") {
              return { data: { agent_slug: "operator" }, error: null };
            }
            return { data: null, error: null };
          },
        }),
      }),
      upsert: async () => ({ error: null }),
    }),
  });
});

const baseRow = {
  id: "d-1",
  tenant_id: "t-1",
  agent_run_id: "r-1",
  decision_class: "operator.file-jira-issue",
  body: {
    project_key: "SCRUM",
    summary: "x",
    description_markdown: "y",
    issue_type: "Task",
  },
  handler: "jira.create_issue",
  status: "dispatching",
};

describe("executeOperatorAction", () => {
  it("fleet halt: claims, fires NOTHING, releases claim, returns ok:false", async () => {
    mocks.claimDecisionMock.mockResolvedValueOnce(baseRow);
    mocks.fleetHaltedMock.mockResolvedValueOnce(true);

    const out = await executeOperatorAction("d-1");

    expect(out.ok).toBe(false);
    expect(out.error).toBe("fleet_halted");
    expect(mocks.jiraCreateIssueMock).not.toHaveBeenCalled();
    expect(mocks.markDispatchedMock).not.toHaveBeenCalled();
    expect(mocks.releaseClaimMock).toHaveBeenCalledWith("d-1", "fleet_halted");
  });

  it("jira: win claim → absolute URL composed from connector_metadata.team_name", async () => {
    mocks.claimDecisionMock.mockResolvedValueOnce(baseRow);
    mocks.jiraCreateIssueMock.mockResolvedValueOnce({
      key: "SCRUM-99",
      id: "i-99",
      url: "/browse/SCRUM-99",
    });
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(true);
    expect(out.result?.external_key).toBe("SCRUM-99");
    expect(out.result?.url).toBe("https://upcar-team.atlassian.net/browse/SCRUM-99");
    expect(mocks.markDispatchedMock).toHaveBeenCalledWith("d-1");
    expect(mocks.releaseClaimMock).not.toHaveBeenCalled();
  });

  it("jira: missing connector_metadata.team_name → bare key (url undefined)", async () => {
    connectorTeamName = null;
    mocks.claimDecisionMock.mockResolvedValueOnce(baseRow);
    mocks.jiraCreateIssueMock.mockResolvedValueOnce({
      key: "SCRUM-99",
      id: "i-99",
      url: "/browse/SCRUM-99",
    });
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(true);
    expect(out.result?.external_key).toBe("SCRUM-99");
    expect(out.result?.url).toBeUndefined();
  });

  it("jira: malformed team_name (slash injection) → bare key (url undefined)", async () => {
    connectorTeamName = "evil/../foo";
    mocks.claimDecisionMock.mockResolvedValueOnce(baseRow);
    mocks.jiraCreateIssueMock.mockResolvedValueOnce({
      key: "SCRUM-99",
      id: "i-99",
      url: "/browse/SCRUM-99",
    });
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(true);
    expect(out.result?.url).toBeUndefined();
  });

  it("jira: lost claim → ok with already_claimed, no external call", async () => {
    mocks.claimDecisionMock.mockResolvedValueOnce(null);
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(true);
    expect(out.already_claimed).toBe(true);
    expect(mocks.jiraCreateIssueMock).not.toHaveBeenCalled();
  });

  it("jira: connector throws → releaseClaim called, ok:false returned", async () => {
    mocks.claimDecisionMock.mockResolvedValueOnce(baseRow);
    mocks.jiraCreateIssueMock.mockRejectedValueOnce(new Error("auth_expired"));
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("auth_expired");
    expect(mocks.releaseClaimMock).toHaveBeenCalledWith("d-1", expect.stringContaining("auth_expired"));
  });

  it("jira: empty key from API → releaseClaim, ok:false", async () => {
    mocks.claimDecisionMock.mockResolvedValueOnce(baseRow);
    mocks.jiraCreateIssueMock.mockResolvedValueOnce({ key: "", id: "", url: "" });
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(false);
    expect(mocks.releaseClaimMock).toHaveBeenCalled();
  });

  it("linear: win claim → identifier returned", async () => {
    mocks.claimDecisionMock.mockResolvedValueOnce({
      ...baseRow,
      decision_class: "operator.file-linear-issue",
      body: {
        team_id: "team-1",
        title: "T",
        description_markdown: "D",
      },
    });
    mocks.linearCreateIssueMock.mockResolvedValueOnce({
      id: "uuid",
      identifier: "ENG-42",
      url: "https://linear.app/x/issue/ENG-42",
    });
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(true);
    expect(out.result?.external_key).toBe("ENG-42");
  });

  it("slack: win claim → channel + ts returned", async () => {
    mocks.claimDecisionMock.mockResolvedValueOnce({
      ...baseRow,
      decision_class: "operator.post-slack-message",
      body: { channel_id: "C1", text: "hi" },
    });
    mocks.postMessageExecuteMock.mockResolvedValueOnce({
      ts: "1700000000.0001",
      channel: "C1",
    });
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(true);
    expect(out.result?.channel).toBe("C1");
    expect(out.result?.ts).toBe("1700000000.0001");
  });

  it("unknown decision_class → releaseClaim + ok:false", async () => {
    mocks.claimDecisionMock.mockResolvedValueOnce({
      ...baseRow,
      decision_class: "operator.fly-to-mars",
    });
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("unsupported decision_class");
    expect(mocks.releaseClaimMock).toHaveBeenCalled();
  });

  it("jira: body invalid (missing summary) → releaseClaim", async () => {
    mocks.claimDecisionMock.mockResolvedValueOnce({
      ...baseRow,
      body: { project_key: "SCRUM", description_markdown: "x" },
    });
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("invalid");
    expect(mocks.releaseClaimMock).toHaveBeenCalled();
  });

  it("claim lost: row still proposed + autonomy=approval → status='pending_approval'", async () => {
    mocks.claimDecisionMock.mockResolvedValueOnce(null);
    mocks.serviceClientMock.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { status: "proposed", autonomy_at_emit: "approval" },
              error: null,
            }),
          }),
        }),
      }),
    });
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(true);
    expect(out.status).toBe("pending_approval");
    expect(out.already_claimed).toBeUndefined();
    expect(mocks.jiraCreateIssueMock).not.toHaveBeenCalled();
  });

  it("claim lost: row rejected (kill_switch) → status='rejected'", async () => {
    mocks.claimDecisionMock.mockResolvedValueOnce(null);
    mocks.serviceClientMock.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { status: "rejected", autonomy_at_emit: "forbidden" },
              error: null,
            }),
          }),
        }),
      }),
    });
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(true);
    expect(out.status).toBe("rejected");
    expect(mocks.jiraCreateIssueMock).not.toHaveBeenCalled();
  });

  it("claim lost: row already acted by other worker → status='race_lost'", async () => {
    mocks.claimDecisionMock.mockResolvedValueOnce(null);
    mocks.serviceClientMock.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { status: "acted", autonomy_at_emit: "auto" },
              error: null,
            }),
          }),
        }),
      }),
    });
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(true);
    expect(out.status).toBe("race_lost");
    expect(out.already_claimed).toBe(true);
  });

  function autoProposedPeek() {
    mocks.serviceClientMock.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                status: "proposed",
                autonomy_at_emit: "auto",
                tenant_id: "t-1",
                decision_class: "operator.post-slack-message",
              },
              error: null,
            }),
          }),
        }),
      }),
    });
  }

  it("auto-fire OVER cap → status='rate_capped', NOT claimed, NOT executed, event logged", async () => {
    autoProposedPeek();
    mocks.checkAutoFireRateCapMock.mockResolvedValueOnce({
      allowed: false,
      count: 30,
      cap: 30,
      reason: "over_cap",
    });
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(true);
    expect(out.status).toBe("rate_capped");
    expect(mocks.claimDecisionMock).not.toHaveBeenCalled();
    expect(mocks.postMessageExecuteMock).not.toHaveBeenCalled();
    expect(mocks.jiraCreateIssueMock).not.toHaveBeenCalled();
    expect(mocks.logEventMock).toHaveBeenCalledTimes(1);
    const logged = mocks.logEventMock.mock.calls[0][0];
    expect(logged.level).toBe("warn");
    expect(logged.code).toBe("auto_fire_rate_capped");
    expect(logged.meta.decision_class).toBe("operator.post-slack-message");
    expect(mocks.logDecisionNotTakenMock).toHaveBeenCalledTimes(1);
    const cf = mocks.logDecisionNotTakenMock.mock.calls[0][0];
    expect(cf.rejection_type).toBe("cap_exceeded");
    expect(cf.reason_code).toBe("auto_fire_rate_capped");
    expect(cf.decision_class).toBe("operator.post-slack-message");
  });

  it("auto-fire cap COUNT ERROR → fail-closed → status='rate_capped' (route to approval)", async () => {
    autoProposedPeek();
    mocks.checkAutoFireRateCapMock.mockResolvedValueOnce({
      allowed: false,
      count: -1,
      cap: 30,
      reason: "count_error",
    });
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(true);
    expect(out.status).toBe("rate_capped");
    expect(mocks.claimDecisionMock).not.toHaveBeenCalled();
    expect(mocks.postMessageExecuteMock).not.toHaveBeenCalled();
    const logged = mocks.logEventMock.mock.calls[0][0];
    expect(logged.code).toBe("auto_fire_rate_cap_count_error");
  });

  it("auto-fire UNDER cap → cap gate passes → claim + execute as normal", async () => {
    mocks.serviceClientMock.mockReturnValue({
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            maybeSingle: async () => {
              if (table === "decisions") {
                return {
                  data: {
                    status: "proposed",
                    autonomy_at_emit: "auto",
                    tenant_id: "t-1",
                    decision_class: "operator.post-slack-message",
                  },
                  error: null,
                };
              }
              if (table === "agent_runs") return { data: { agent_slug: "operator" }, error: null };
              return { data: null, error: null };
            },
          }),
        }),
        upsert: async () => ({ error: null }),
      }),
    });
    mocks.checkAutoFireRateCapMock.mockResolvedValueOnce({ allowed: true, count: 2, cap: 30 });
    mocks.claimDecisionMock.mockResolvedValueOnce({
      ...baseRow,
      decision_class: "operator.post-slack-message",
      body: { channel_id: "C1", text: "hi" },
    });
    mocks.postMessageExecuteMock.mockResolvedValueOnce({ ts: "1700000000.0001", channel: "C1" });
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(true);
    expect(out.status).toBe("executed");
    expect(mocks.claimDecisionMock).toHaveBeenCalled();
    expect(mocks.postMessageExecuteMock).toHaveBeenCalled();
    expect(mocks.logEventMock).not.toHaveBeenCalled();
  });

  it("approval-gated class is UNAFFECTED by the cap (gate skipped, no cap check, → pending_approval)", async () => {
    mocks.checkAutoFireRateCapMock.mockResolvedValue({
      allowed: false,
      count: 999,
      cap: 30,
      reason: "over_cap",
    });
    mocks.serviceClientMock.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                status: "proposed",
                autonomy_at_emit: "approval",
                tenant_id: "t-1",
                decision_class: "operator.file-jira-issue",
              },
              error: null,
            }),
          }),
        }),
      }),
    });
    mocks.claimDecisionMock.mockResolvedValueOnce(null);
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(true);
    expect(out.status).toBe("pending_approval");
    expect(mocks.checkAutoFireRateCapMock).not.toHaveBeenCalled();
    expect(mocks.logEventMock).not.toHaveBeenCalled();
  });

  it("peek read error → does NOT fail closed inline (falls through to claim path)", async () => {
    let peekCount = 0;
    mocks.serviceClientMock.mockReturnValue({
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            maybeSingle: async () => {
              if (table === "decisions") {
                peekCount++;
                return { data: null, error: { message: "peek timeout" } };
              }
              if (table === "agent_runs") return { data: { agent_slug: "operator" }, error: null };
              return { data: null, error: null };
            },
          }),
        }),
        upsert: async () => ({ error: null }),
      }),
    });
    mocks.claimDecisionMock.mockResolvedValueOnce({
      ...baseRow,
      decision_class: "operator.post-slack-message",
      body: { channel_id: "C1", text: "hi" },
    });
    mocks.postMessageExecuteMock.mockResolvedValueOnce({ ts: "t", channel: "C1" });
    const out = await executeOperatorAction("d-1");
    expect(out.ok).toBe(true);
    expect(out.status).toBe("executed");
    expect(mocks.checkAutoFireRateCapMock).not.toHaveBeenCalled();
    expect(peekCount).toBeGreaterThan(0);
  });
});
