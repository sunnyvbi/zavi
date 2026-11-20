import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[],
  error: null as { message: string } | null,
  slackWorkspaceCount: 1 as number,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => ({
      select: (_cols: string, opts?: { count?: string; head?: boolean }) => ({
        eq:
          table === "slack_workspaces" && opts?.head
            ? async (_col: string, _val: string) => ({
                count: mocks.slackWorkspaceCount,
                error: null,
              })
            : async (_col: string, _val: string) => ({
                data: mocks.rows,
                error: mocks.error,
              }),
      }),
    }),
  }),
}));

import { readConnectorList } from "../metadata";

beforeEach(() => {
  mocks.rows = [];
  mocks.error = null;
  mocks.slackWorkspaceCount = 1;
});

describe("readConnectorList", () => {
  it("surfaces EVERY connected connector row, including operator_db + jira (the regression)", async () => {
    mocks.rows = [
      { slug: "operator_db", team_name: "Operator DB", account_login: null, repo_full_names: null, connected_at: "2026-05-17T05:04:08Z" },
      { slug: "github", team_name: null, account_login: "rravi149", repo_full_names: ["a/b", "a/c"], connected_at: "2026-05-18T19:55:02Z" },
      { slug: "jira", team_name: "upcar-team", account_login: null, repo_full_names: null, connected_at: "2026-05-18T01:56:48Z" },
      { slug: "slack", team_name: "Upcar", account_login: null, repo_full_names: null, connected_at: "2026-05-18T01:56:33Z" },
      { slug: "meta_ads", team_name: "Meta Ads", account_login: null, repo_full_names: null, connected_at: "2026-05-21T02:56:35Z" },
    ];
    const list = await readConnectorList("t1");
    expect(list.map((c) => c.slug).sort()).toEqual(
      ["github", "jira", "meta_ads", "operator_db", "slack"],
    );
    expect(list.every((c) => c.connected === true)).toBe(true);
  });

  it("returns the stored SendGrid permission groups on the email row only", async () => {
    const groups = ["mail_send", "marketing_lists_read", "single_sends_write", "stats_read", "senders_read", "suppression_groups_read"];
    mocks.rows = [
      { slug: "email", team_name: null, account_login: null, repo_full_names: null, connected_at: "t", scopes: groups },
      { slug: "slack", team_name: "Upcar", account_login: null, repo_full_names: null, connected_at: "t", scopes: ["chat:write"] },
    ];
    const list = await readConnectorList("t1");
    expect(list.find((c) => c.slug === "email")?.scopes).toEqual(groups);
    expect(list.find((c) => c.slug === "slack")).not.toHaveProperty("scopes");
  });

  it("computes repo_count only for github", async () => {
    mocks.rows = [
      { slug: "github", team_name: null, account_login: "x", repo_full_names: ["a/b", "a/c", "a/d"], connected_at: "t" },
      { slug: "operator_db", team_name: "DB", account_login: null, repo_full_names: null, connected_at: "t" },
    ];
    const list = await readConnectorList("t1");
    const gh = list.find((c) => c.slug === "github")!;
    const db = list.find((c) => c.slug === "operator_db")!;
    expect(gh.repo_count).toBe(3);
    expect(db.repo_count).toBeUndefined();
  });

  it("github repo_count defaults to 0 when repo_full_names is null", async () => {
    mocks.rows = [{ slug: "github", team_name: null, account_login: "x", repo_full_names: null, connected_at: "t" }];
    const list = await readConnectorList("t1");
    expect(list[0].repo_count).toBe(0);
  });

  it("returns an empty list when the tenant has no connectors", async () => {
    mocks.rows = [];
    expect(await readConnectorList("t1")).toEqual([]);
  });

  it("throws a descriptive error when the read fails", async () => {
    mocks.error = { message: "boom" };
    await expect(readConnectorList("t1")).rejects.toThrow(/connector_metadata list read failed for t1: boom/);
  });

  it("surfaces workspace_count for slack from slack_workspaces (multi-workspace, Slice 2)", async () => {
    mocks.rows = [
      { slug: "slack", team_name: "Upcar", account_login: null, repo_full_names: null, connected_at: "t" },
      { slug: "github", team_name: null, account_login: "x", repo_full_names: ["a/b"], connected_at: "t" },
    ];
    mocks.slackWorkspaceCount = 2;
    const list = await readConnectorList("t1");
    const slack = list.find((c) => c.slug === "slack")!;
    const gh = list.find((c) => c.slug === "github")!;
    expect(slack.workspace_count).toBe(2);
    expect(gh.workspace_count).toBeUndefined();
  });

  it("workspace_count floors at 1 even when the count query returns 0/null", async () => {
    mocks.rows = [
      { slug: "slack", team_name: "Upcar", account_login: null, repo_full_names: null, connected_at: "t" },
    ];
    mocks.slackWorkspaceCount = 0;
    const list = await readConnectorList("t1");
    expect(list[0].workspace_count).toBe(1);
  });
});
