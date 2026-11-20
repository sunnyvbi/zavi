import { describe, it, expect, vi, beforeEach } from "vitest";

const jiraAddComment = vi.fn(
  async (
    _tenant: string,
    _input: { issue_key: string; body_markdown: string },
    _opts?: { agentAuto?: boolean },
  ) => ({ id: "jc1" }),
);
const linearAddComment = vi.fn(
  async (
    _tenant: string,
    _input: { issue_id: string; body_markdown: string },
    _opts?: { agentAuto?: boolean },
  ) => ({ id: "lc1" }),
);
const jiraTransition = vi.fn();
const linearUpdateState = vi.fn();

vi.mock("@/services/mcp/internal/jira", () => ({
  jiraAddComment: (
    t: string,
    i: { issue_key: string; body_markdown: string },
    o?: { agentAuto?: boolean },
  ) => jiraAddComment(t, i, o),
  jiraTransitionIssue: (...a: unknown[]) => jiraTransition(...a),
}));
vi.mock("@/services/mcp/internal/linear", () => ({
  linearAddComment: (
    t: string,
    i: { issue_id: string; body_markdown: string },
    o?: { agentAuto?: boolean },
  ) => linearAddComment(t, i, o),
  linearUpdateIssueState: (...a: unknown[]) => linearUpdateState(...a),
}));

let enablementRows: Array<{ server_id: string; enabled: boolean }> = [];
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "tenant_mcp_servers") {
        return {
          select: () => ({
            eq: () => ({
              in: () => Promise.resolve({ data: enablementRows, error: null }),
            }),
          }),
        };
      }
      throw new Error(`UNEXPECTED TABLE ACCESS: ${table}`);
    },
  }),
}));

import { postTrackerPrComment } from "../tracker-pr-comment";

beforeEach(() => {
  jiraAddComment.mockClear();
  linearAddComment.mockClear();
  jiraTransition.mockClear();
  linearUpdateState.mockClear();
  enablementRows = [];
});

describe("postTrackerPrComment (P1-3 — tracker PR-link comments)", () => {
  it("ticket-origin run (Jira URL) → posts an [agent-auto] PR-link comment, NO transition", async () => {
    enablementRows = [
      { server_id: "jira", enabled: true },
      { server_id: "linear", enabled: false },
    ];
    const ref = await postTrackerPrComment({
      tenant_id: "t1",
      originText: "implement https://x.atlassian.net/browse/SCRUM-42 please",
      pr_url: "https://github.com/o/r/pull/9",
      event: "opened",
    });
    expect(ref).toEqual({ connector: "jira", key: "SCRUM-42" });
    expect(jiraAddComment).toHaveBeenCalledTimes(1);
    const [tenant, body, opts] = jiraAddComment.mock.calls[0];
    expect(tenant).toBe("t1");
    expect(body).toEqual({
      issue_key: "SCRUM-42",
      body_markdown: expect.stringContaining("https://github.com/o/r/pull/9"),
    });
    expect(opts).toEqual({ agentAuto: true });
    expect(jiraTransition).not.toHaveBeenCalled();
    expect(linearUpdateState).not.toHaveBeenCalled();
    expect(linearAddComment).not.toHaveBeenCalled();
  });

  it("merged event uses merged copy + the merged PR url", async () => {
    enablementRows = [{ server_id: "linear", enabled: true }];
    const ref = await postTrackerPrComment({
      tenant_id: "t1",
      originText: "ENG-7 add the field",
      pr_url: "https://github.com/o/r/pull/11",
      event: "merged",
    });
    expect(ref).toEqual({ connector: "linear", key: "ENG-7" });
    expect(linearAddComment).toHaveBeenCalledTimes(1);
    const [, body] = linearAddComment.mock.calls[0];
    expect(body).toEqual({
      issue_id: "ENG-7",
      body_markdown: expect.stringMatching(/merged.*github\.com\/o\/r\/pull\/11/),
    });
    expect(jiraAddComment).not.toHaveBeenCalled();
  });

  it("NON-ticket run → no comment posted", async () => {
    enablementRows = [{ server_id: "jira", enabled: true }];
    const ref = await postTrackerPrComment({
      tenant_id: "t1",
      originText: "just fix the null-pointer bug in checkout, no ticket",
      pr_url: "https://github.com/o/r/pull/12",
      event: "opened",
    });
    expect(ref).toBeNull();
    expect(jiraAddComment).not.toHaveBeenCalled();
    expect(linearAddComment).not.toHaveBeenCalled();
  });

  it("bare key with BOTH trackers enabled → ambiguous → no comment", async () => {
    enablementRows = [
      { server_id: "jira", enabled: true },
      { server_id: "linear", enabled: true },
    ];
    const ref = await postTrackerPrComment({
      tenant_id: "t1",
      originText: "ship SCRUM-100",
      pr_url: "https://github.com/o/r/pull/13",
      event: "opened",
    });
    expect(ref).toBeNull();
    expect(jiraAddComment).not.toHaveBeenCalled();
    expect(linearAddComment).not.toHaveBeenCalled();
  });

  it("no tracker enabled → short-circuits before resolving", async () => {
    enablementRows = [];
    const ref = await postTrackerPrComment({
      tenant_id: "t1",
      originText: "https://x.atlassian.net/browse/SCRUM-42",
      pr_url: "https://github.com/o/r/pull/14",
      event: "opened",
    });
    expect(ref).toBeNull();
    expect(jiraAddComment).not.toHaveBeenCalled();
  });

  it("a connector throw is swallowed (best-effort) → null, never throws", async () => {
    enablementRows = [{ server_id: "jira", enabled: true }];
    jiraAddComment.mockRejectedValueOnce(new Error("404 stale issue key"));
    const ref = await postTrackerPrComment({
      tenant_id: "t1",
      originText: "https://x.atlassian.net/browse/SCRUM-42",
      pr_url: "https://github.com/o/r/pull/15",
      event: "opened",
    });
    expect(ref).toBeNull();
  });
});
