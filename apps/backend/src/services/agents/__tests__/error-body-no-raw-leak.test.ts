import { describe, expect, it } from "vitest";
import { synthesizeErrorBody } from "../error-body";

const REAL_ABORT = `dispatch_inner: Claude Code process aborted by user
Error: Claude Code process aborted by user
    at ChildProcess.<anonymous> (file:///app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:60:7666)
    at ChildProcess.emit (node:events:531:35)
    at abortChildProcess (node:child_process:750:13)`;

const RAW_SHAPES: readonly [string, string][] = [
  ["dispatch abort + stack", REAL_ABORT],
  ["parse_failed", "parse_failed: could not parse envelope from model output"],
  ["boot_reap", "boot_reap: orphaned by container restart (worker died mid-run)"],
  ["stale_reap", "stale_reap: run reaped after inactivity"],
  [
    "worktree disk",
    "worktree_insufficient_disk: per-run worktree create failed for run=f9b8168b: insufficient_disk: a second working tree needs ~3657MB",
  ],
  ["rate limit", "HTTP 429 rate_limit exceeded, Retry-After: 30"],
  ["transient", "fetch failed: ECONNRESET"],
  ["connector", "slack_not_connected: no token for tenant"],
  ["reauth", "jira_auth_expired: refresh token rejected"],
  ["repo access", "resolve-repo-creds: repo_access_blocked — no repositories shared"],
  ["naked throw", "TypeError: Cannot read properties of undefined (reading 'id')"],
];

const FORBIDDEN: readonly [string, RegExp][] = [
  ["code fence", /```/],
  ["stack frame", /^\s*at\s+\S+/m],
  ["module path", /node_modules|\.mjs\b|\.ts:\d+|file:\/\/\//],
  ["vendor/SDK name", /@anthropic-ai|claude-agent-sdk|Claude Code/i],
  ["internal error tag", /\bdispatch_inner\b|\bparse_failed\b|\bboot_reap\b|\bstale_reap\b/],
];

describe("synthesizeErrorBody — never renders the raw error to a customer", () => {
  for (const [name, raw] of RAW_SHAPES) {
    for (const [what, pattern] of FORBIDDEN) {
      it(`${name}: body contains no ${what}`, () => {
        const { markdown } = synthesizeErrorBody(raw, "operator");
        expect(markdown).not.toMatch(pattern);
      });
    }

    it(`${name}: body is non-empty human copy`, () => {
      const { markdown } = synthesizeErrorBody(raw, "operator");
      expect(markdown.trim().length).toBeGreaterThan(20);
    });
  }

  it("the exact prod abort no longer leaks the SDK path (the P0 case)", () => {
    const { markdown } = synthesizeErrorBody(REAL_ABORT, "support-lead");
    expect(markdown).not.toContain("sdk.mjs");
    expect(markdown).not.toContain("ChildProcess");
    expect(markdown).toMatch(/try again/i);
    expect(markdown).toMatch(/on my end/i);
  });

  it("an unclassified failure does not end in a dangling colon", () => {
    const { markdown } = synthesizeErrorBody(REAL_ABORT, "operator");
    expect(markdown).not.toMatch(/this:\s*$/);
  });

  describe("resolve-repo-creds sub-classification — say the true thing, or say nothing specific", () => {
    it("App not installed → Connect, NOT 'grant repo access'", () => {
      const { markdown } = synthesizeErrorBody(
        "resolve-repo-creds: GitHub App not connected for this tenant. Install via /connectors before running sandbox agents.",
        "engineer",
      );
      expect(markdown).toMatch(/isn't connected/i);
      expect(markdown).not.toMatch(/no repositories are shared/i);
    });

    it("connected but no repos selected → grant repo access", () => {
      const { markdown } = synthesizeErrorBody(
        "resolve-repo-creds: GitHub is connected but no repositories are selected for Zavi to reach.",
        "engineer",
      );
      expect(markdown).toMatch(/no repositories are shared/i);
    });

    it("malformed target → ask for owner/name, not a connector fix", () => {
      const { markdown } = synthesizeErrorBody(
        `resolve-repo-creds: repo_hint "upcar" must be 'owner/name'`,
        "engineer",
      );
      expect(markdown).toMatch(/owner\/name/);
      expect(markdown).not.toMatch(/Settings → Connectors/);
    });

    const INTERNAL_RAWS: readonly [string, string][] = [
      ["connector_metadata read failure", "resolve-repo-creds: connector_metadata read failed: timeout"],
      [
        "missing provision token",
        "resolve-repo-creds: GITHUB_PROVISION_TOKEN not configured — cannot clone/push the provisioned autopilot repo.",
      ],
      [
        "provisioned-repo gate refusal",
        `resolve-repo-creds: refusing autopilot target "acme/app" — provisioned-repo gate failed (not_provisioned).`,
      ],
    ];

    for (const [name, raw] of INTERNAL_RAWS) {
      it(`${name} → honest 'on my end', never a false config instruction`, () => {
        const { markdown } = synthesizeErrorBody(raw, "engineer");
        expect(markdown).toMatch(/on my end/i);
        expect(markdown).not.toMatch(/Settings → Connectors/);
        expect(markdown).not.toMatch(/GITHUB_PROVISION_TOKEN|connector_metadata|autopilot/i);
      });
    }
  });

  it("a connector failure still carries its action link", () => {
    const { markdown, action_link } = synthesizeErrorBody(
      "slack_not_connected: no token for tenant",
      "operator",
    );
    expect(action_link).toContain("connect:slack");
    expect(markdown).toContain("Connect Slack");
  });
});
