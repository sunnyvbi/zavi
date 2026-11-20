
import { describe, it, expect } from "vitest";
import {
  synthesizeErrorBody,
  sanitizeErrorString,
  chatFailureBubbleBody,
} from "../error-body";

describe("sanitizeErrorString", () => {
  it("redacts Bearer tokens", () => {
    const out = sanitizeErrorString("auth header: Bearer abc.def.ghi-123456");
    expect(out).toMatch(/Bearer <redacted>/);
    expect(out).not.toMatch(/abc\.def\.ghi-/);
  });

  it("redacts Stripe live secret keys", () => {
    const out = sanitizeErrorString("error: sk_live_abc123def456ghi789 invalid");
    expect(out).toMatch(/sk_live_<redacted>/);
    expect(out).not.toMatch(/abc123def456ghi789/);
  });

  it("redacts Stripe test publishable keys", () => {
    const out = sanitizeErrorString("pk_test_01234567890abcdef returned 401");
    expect(out).toMatch(/pk_test_<redacted>/);
  });

  it("redacts Slack bot tokens", () => {
    const out = sanitizeErrorString("token xoxb-1234567890-abcdefghi");
    expect(out).toMatch(/xoxb-<redacted>/);
  });

  it("redacts Slack user tokens", () => {
    const out = sanitizeErrorString("Authorization: xoxp-12345-67890-abcdef");
    expect(out).toMatch(/xoxp-<redacted>/);
  });

  it("redacts env-var-shape leaks (UPPER_SNAKE=token, 12+ chars)", () => {
    const out = sanitizeErrorString("Failed: ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGh1234 was wrong");
    expect(out).toMatch(/ANTHROPIC_API_KEY=<redacted>/);
    expect(out).not.toMatch(/sk-ant-api03-AbCdEfGh1234/);
  });

  it("does NOT false-positive on short numeric assignments", () => {
    const out = sanitizeErrorString("count=42 retries=3");
    expect(out).toMatch(/count=42/);
    expect(out).toMatch(/retries=3/);
  });

  it("non-secret text passes through unchanged", () => {
    const text = "stripe_not_connected: please connect Stripe in Settings";
    expect(sanitizeErrorString(text)).toBe(text);
  });

  it("multi-secret strings get fully scrubbed", () => {
    const raw = "Bearer abcdefghij ... sk_live_zzyyxxwwvvuu and xoxb-1234567890-aaaa";
    const out = sanitizeErrorString(raw);
    expect(out).toMatch(/Bearer <redacted>/);
    expect(out).toMatch(/sk_live_<redacted>/);
    expect(out).toMatch(/xoxb-<redacted>/);
  });
});

describe("synthesizeErrorBody: action-link routing", () => {
  it("renders a Connect button for *_not_connected", () => {
    const r = synthesizeErrorBody("jira_not_connected", "operator");
    expect(r.action_link).toBe("[Connect Jira](/__praxis_action__/connect:jira)");
    expect(r.markdown).toMatch(/Connect Jira/);
    expect(r.markdown).not.toMatch(/agent: `/);
  });

  it("renders a Reconnect button for *_auth_expired", () => {
    const r = synthesizeErrorBody("github_auth_expired", "operator");
    expect(r.action_link).toBe(
      "[Reconnect Github](/__praxis_action__/reauth:github)",
    );
    expect(r.markdown).toMatch(/Reconnect Github/);
  });

  it("title-cases multi-segment service names (google_ads → Google Ads)", () => {
    const r = synthesizeErrorBody("google_ads_not_connected", "operator");
    expect(r.action_link).toBe(
      "[Connect Google Ads](/__praxis_action__/connect:google_ads)",
    );
  });

  it("error code embedded in a larger JSON payload still resolves", () => {
    const raw = '{"error":"stripe_not_connected","message":"please connect"}';
    const r = synthesizeErrorBody(raw, "operator");
    expect(r.action_link).toBe(
      "[Connect Stripe](/__praxis_action__/connect:stripe)",
    );
  });
});

describe("synthesizeErrorBody: rate-limit + transient errors get NO action link", () => {
  it("HTTP 403 secondary rate-limit → no action link", () => {
    const raw = "HTTP 403 from github: secondary rate-limit exceeded";
    const r = synthesizeErrorBody(raw, "operator");
    expect(r.action_link).toBeNull();
    expect(r.markdown).not.toMatch(/Connect/);
    expect(r.markdown).not.toMatch(/Reconnect/);
    expect(r.markdown).toMatch(/try again/i);
  });

  it("bare HTTP 403 + slack_auth_expired STILL routes to Reconnect (403 is not a rate limit)", () => {
    const r = synthesizeErrorBody(
      "slack__post_message failed: HTTP 403 — slack_auth_expired",
      "support-lead",
    );
    expect(r.action_link).toBe(
      "[Reconnect Slack](/__praxis_action__/reauth:slack)",
    );
    expect(r.markdown).not.toMatch(/rate-limit/i);
  });

  it("bare HTTP 403 + github_not_connected STILL routes to Connect", () => {
    const r = synthesizeErrorBody(
      "HTTP 403 Forbidden: github_not_connected",
      "engineer",
    );
    expect(r.action_link).toBe(
      "[Connect Github](/__praxis_action__/connect:github)",
    );
    expect(r.markdown).not.toMatch(/rate-limit/i);
  });

  it("a bare HTTP 403 with no connector hint does NOT claim a transient rate-limit", () => {
    const r = synthesizeErrorBody("HTTP 403 Forbidden", "operator");
    expect(r.action_link).toBeNull();
    expect(r.markdown).not.toMatch(/rate-limit/i);
  });

  it("HTTP 429 → no action link, retry-soon trailer", () => {
    const r = synthesizeErrorBody("HTTP 429 Too Many Requests", "operator");
    expect(r.action_link).toBeNull();
    expect(r.markdown).toMatch(/try again|rate-limit/i);
  });

  it("Retry-After header → no action link", () => {
    const r = synthesizeErrorBody("Retry-After: 60", "operator");
    expect(r.action_link).toBeNull();
  });

  it("ECONNRESET transient → no action link, transient trailer", () => {
    const r = synthesizeErrorBody("ECONNRESET while calling upstream", "operator");
    expect(r.action_link).toBeNull();
    expect(r.markdown).toMatch(/Transient|blip|try the same question/i);
  });

  it("ETIMEDOUT transient → no action link", () => {
    const r = synthesizeErrorBody("ETIMEDOUT after 60s", "operator");
    expect(r.action_link).toBeNull();
  });

  it("github secondary rate-limit DOES NOT route to Reconnect GitHub (b51f2c47 case)", () => {
    const raw = "github__search_code: HTTP 403 secondary rate-limit";
    const r = synthesizeErrorBody(raw, "operator");
    expect(r.action_link).toBeNull();
    expect(r.markdown).not.toMatch(/Connect GitHub|Reconnect GitHub/);
  });
});

describe("synthesizeErrorBody: generic + fallback shapes", () => {
  it("unknown error → honest human copy, no action link, no raw string", () => {
    const r = synthesizeErrorBody("something went wrong upstream", "engineer");
    expect(r.action_link).toBeNull();
    expect(r.markdown).toMatch(/couldn't finish it/i);
    expect(r.markdown).toMatch(/try again/i);
    expect(r.markdown).not.toMatch(/Runs tab/);
    expect(r.markdown).not.toMatch(/something went wrong upstream/);
  });

  it("opener line does NOT leak the internal agent slug", () => {
    const r = synthesizeErrorBody("oops", "trust-safety");
    expect(r.markdown).not.toMatch(/agent: `/);
    expect(r.markdown).not.toMatch(/trust-safety/);
  });

  it("the raw error is NEVER fenced into the customer body", () => {
    const r = synthesizeErrorBody("error message here", "operator");
    expect(r.markdown).not.toMatch(/```/);
    expect(r.markdown).not.toMatch(/error message here/);
  });

  it("a huge raw error cannot inflate the body — nothing of it renders", () => {
    const long = "x".repeat(5000);
    const r = synthesizeErrorBody(long, "operator");
    expect(r.markdown.length).toBeLessThan(8000);
    expect(r.markdown).not.toMatch(/xxxx/);
  });

  it("body never exceeds 8000 chars (BODY_CAP)", () => {
    const r = synthesizeErrorBody("a".repeat(50000), "operator");
    expect(r.markdown.length).toBeLessThanOrEqual(8000);
  });
});

describe("synthesizeErrorBody: resolve-repo-creds config error", () => {
  it("gives an actionable repo-grant message, no action link, no Reconnect button", () => {
    const r = synthesizeErrorBody(
      "resolve-repo-creds: payload.repo_hint missing and no repos are accessible to the GitHub installation. Re-install via /connectors and grant repo access.",
      "engineer",
    );
    expect(r.action_link).toBeNull();
    expect(r.markdown).toMatch(/no repositories are shared with Zavi/);
    expect(r.markdown).toMatch(/Settings → Connectors/);
    expect(r.markdown).not.toMatch(/Reconnect/);
    expect(r.markdown).not.toMatch(/See the Runs tab/);
  });

  const NOT_INSTALLED_RAW =
    "resolve-repo-creds: GitHub App not connected for this tenant. " +
    "Install via /connectors before running sandbox agents.";

  it("never-connected → one-click Connect GitHub button", () => {
    const r = synthesizeErrorBody(NOT_INSTALLED_RAW, "engineer");
    expect(r.action_link).toBe("[Connect GitHub](/__praxis_action__/connect:github)");
    expect(r.markdown).toMatch(/GitHub isn't connected to Zavi yet/);
    expect(r.markdown).toContain("/__praxis_action__/connect:github");
  });

  it("uses connect:, NOT reauth: — the App was never installed", () => {
    const r = synthesizeErrorBody(NOT_INSTALLED_RAW, "engineer");
    expect(r.markdown).not.toMatch(/reauth:/);
    expect(r.markdown).not.toMatch(/Reconnect/);
  });

  it("the OTHER repo-access sub-causes keep action_link null (no button would help)", () => {
    const noneSelected = synthesizeErrorBody(
      "resolve-repo-creds: payload.repo_hint missing and no repos are accessible to the GitHub installation.",
      "engineer",
    );
    expect(noneSelected.action_link).toBeNull();
    const badTarget = synthesizeErrorBody(
      "resolve-repo-creds: repo target must be 'owner/name'",
      "engineer",
    );
    expect(badTarget.action_link).toBeNull();
    expect(badTarget.markdown).not.toContain("__praxis_action__");
  });
});

describe("synthesizeErrorBody: infra-reap friendly copy (boot_reap / watchdog_reap)", () => {
  const BOOT_REAP_RAW =
    "boot_reap: orphaned by container restart (worker died mid-run)";

  it("boot_reap → friendly copy, no raw jargon, no fence, no action link", () => {
    const r = synthesizeErrorBody(BOOT_REAP_RAW, "pm");
    expect(r.action_link).toBeNull();
    expect(r.markdown).toMatch(/temporary infrastructure hiccup/);
    expect(r.markdown).toMatch(/re-send your message/);
    expect(r.markdown).not.toMatch(/agent: `/);
    expect(r.markdown).not.toMatch(/boot_reap/);
    expect(r.markdown).not.toMatch(/orphaned by container restart/);
    expect(r.markdown).not.toMatch(/worker died/);
    expect(r.markdown).not.toMatch(/```/);
    expect(r.markdown).not.toMatch(/Something failed/);
  });

  it("watchdog_reap → same friendly copy", () => {
    const r = synthesizeErrorBody(
      "watchdog_reap: no progress for >15min (trigger=chat)",
      "advisor",
    );
    expect(r.action_link).toBeNull();
    expect(r.markdown).toMatch(/temporary infrastructure hiccup/);
    expect(r.markdown).not.toMatch(/watchdog_reap/);
    expect(r.markdown).not.toMatch(/no progress for/);
    expect(r.markdown).not.toMatch(/```/);
  });

  it("'orphaned by container restart' phrasing WITHOUT the prefix is also classified", () => {
    const r = synthesizeErrorBody(
      "run was orphaned by container restart, see logs",
      "growth-lead",
    );
    expect(r.action_link).toBeNull();
    expect(r.markdown).toMatch(/temporary infrastructure hiccup/);
    expect(r.markdown).not.toMatch(/orphaned by container restart/);
  });

  it("chatFailureBubbleBody routes infra-reap errors through the friendly copy", () => {
    const body = chatFailureBubbleBody(BOOT_REAP_RAW, "chief-of-staff");
    expect(body).toMatch(/temporary infrastructure hiccup/);
    expect(body).not.toMatch(/agent: `/);
    expect(body).not.toMatch(/boot_reap/);
  });

  it("a mid-string 'boot_reap' mention without the reap phrasing does NOT classify (prefix-anchored)", () => {
    const r = synthesizeErrorBody(
      "engineer task mentioned boot_reap.ts in a diff and failed",
      "engineer",
    );
    expect(r.markdown).not.toMatch(/temporary infrastructure hiccup/);
    expect(r.markdown).toMatch(/couldn't finish it/i);
    expect(r.markdown).not.toMatch(/Runs tab/);
  });
});

describe("synthesizeErrorBody: stale_reap + Inngest delivery failures", () => {
  it("stale_reap → humanized copy, no raw jargon, no fence, no action link", () => {
    const r = synthesizeErrorBody("stale_reap: run exceeded SLA window", "pm");
    expect(r.action_link).toBeNull();
    expect(r.markdown).toMatch(/temporary hiccup/);
    expect(r.markdown).not.toMatch(/stale_reap/);
    expect(r.markdown).not.toMatch(/SLA window/);
    expect(r.markdown).not.toMatch(/```/);
    expect(r.markdown).not.toMatch(/agent: `/);
  });

  it("stale_reap prefix-anchored — mid-string occurrence does NOT classify", () => {
    const r = synthesizeErrorBody(
      "note: stale_reap logic was updated, actual error was something else",
      "engineer",
    );
    expect(r.markdown).not.toMatch(/temporary hiccup/);
  });

  it("http_unreachable → humanized copy, no raw token, no action link", () => {
    const r = synthesizeErrorBody(
      "Inngest delivery failed: http_unreachable (worker not responding)",
      "growth-lead",
    );
    expect(r.action_link).toBeNull();
    expect(r.markdown).toMatch(/temporary hiccup/);
    expect(r.markdown).not.toMatch(/http_unreachable/);
    expect(r.markdown).not.toMatch(/```/);
  });

  it("exhausted retries → humanized copy, no raw token, no action link", () => {
    const r = synthesizeErrorBody(
      "Function exhausted retries after 4 attempts",
      "chief-of-staff",
    );
    expect(r.action_link).toBeNull();
    expect(r.markdown).toMatch(/temporary hiccup/);
    expect(r.markdown).not.toMatch(/exhausted retries/);
    expect(r.markdown).not.toMatch(/```/);
    expect(r.markdown).not.toMatch(/agent: `/);
  });
});

describe("synthesizeErrorBody: dead GitHub install → Reconnect GitHub", () => {
  const MINT_404 =
    'mintInstallationToken HTTP 404: {"message":"Not Found","documentation_url":"https://docs.github.com/rest/reference/apps#create-an-installation-access-token-for-an-app","status":"404"}';

  it("mintInstallationToken HTTP 404 → Reconnect GitHub button, no 're-send' dead end", () => {
    const r = synthesizeErrorBody(MINT_404, "engineer");
    expect(r.action_link).toBe("[Reconnect GitHub](/__praxis_action__/reauth:github)");
    expect(r.markdown).toMatch(/Reconnect GitHub/);
    expect(r.markdown).toMatch(/Settings → Connectors → GitHub/);
    expect(r.markdown).not.toMatch(/mintInstallationToken/);
    expect(r.markdown).not.toMatch(/documentation_url/);
    expect(r.markdown).not.toMatch(/```/);
    expect(r.markdown).not.toMatch(/Please re-send your message and I'll try again/);
  });

  it("mintInstallationToken HTTP 401 (App key mismatch) also routes to Reconnect", () => {
    const r = synthesizeErrorBody("mintInstallationToken HTTP 401: bad credentials", "engineer");
    expect(r.action_link).toBe("[Reconnect GitHub](/__praxis_action__/reauth:github)");
  });

  it("mintInstallationToken 401 body is DISTINCT from 404 body (temporary vs uninstalled)", () => {
    const r401 = synthesizeErrorBody("mintInstallationToken HTTP 401: bad credentials", "engineer");
    const r404 = synthesizeErrorBody(MINT_404, "engineer");
    expect(r401.action_link).toBe("[Reconnect GitHub](/__praxis_action__/reauth:github)");
    expect(r404.action_link).toBe("[Reconnect GitHub](/__praxis_action__/reauth:github)");
    expect(r401.markdown).toMatch(/temporary|credential/i);
    expect(r401.markdown).toMatch(/GitHub declined/i);
    expect(r404.markdown).toMatch(/uninstalled|replaced/i);
    expect(r401.markdown).not.toBe(r404.markdown);
  });

  it("getInstallation HTTP 404 routes to Reconnect", () => {
    const r = synthesizeErrorBody("getInstallation HTTP 404", "engineer");
    expect(r.action_link).toBe("[Reconnect GitHub](/__praxis_action__/reauth:github)");
  });

  it("chatFailureBubbleBody surfaces the Reconnect copy for the mint 404", () => {
    const body = chatFailureBubbleBody(MINT_404, "engineer");
    expect(body).toMatch(/Reconnect GitHub/);
    expect(body).not.toMatch(/mintInstallationToken/);
  });

  it("github mint secondary rate-limit (403) does NOT route to Reconnect", () => {
    const r = synthesizeErrorBody(
      "mintInstallationToken HTTP 403: secondary rate-limit exceeded",
      "engineer",
    );
    expect(r.action_link).toBeNull();
    expect(r.markdown).not.toMatch(/Reconnect GitHub/);
    expect(r.markdown).toMatch(/try again|rate-limit/i);
  });

  it("an unrelated 404 in a customer error does NOT route to Reconnect", () => {
    const r = synthesizeErrorBody("GET /api/widgets returned HTTP 404", "engineer");
    expect(r.action_link).toBeNull();
    expect(r.markdown).not.toMatch(/Reconnect GitHub/);
    expect(r.markdown).toMatch(/couldn't finish it/i);
  });
});

describe("synthesizeErrorBody: a secret-bearing error renders NOTHING", () => {
  it("Bearer leak: neither the token nor its redaction marker reaches the customer", () => {
    const r = synthesizeErrorBody("auth: Bearer abc.def.ghi-token-12345", "operator");
    expect(r.markdown).not.toMatch(/abc\.def\.ghi-token/);
    expect(r.markdown).not.toMatch(/Bearer/);
    expect(r.markdown).not.toMatch(/redacted/);
  });

  it("Stripe secret: neither the key nor its redaction marker reaches the customer", () => {
    const r = synthesizeErrorBody(
      "Stripe call failed with key sk_live_ABCDEF1234567890XYZ",
      "operator",
    );
    expect(r.markdown).not.toMatch(/ABCDEF1234567890XYZ/);
    expect(r.markdown).not.toMatch(/sk_live/);
  });
});

describe("synthesizeErrorBody: worktree setup failure (timeout / early-kill / git)", () => {
  const assertHonestSetup = (r: { markdown: string; action_link: string | null }) => {
    expect(r.action_link).toBeNull();
    expect(r.markdown).toMatch(/setting up your repository/i);
    expect(r.markdown).toMatch(/try again in a few minutes/i);
    expect(r.markdown).not.toMatch(/re-send your message/i);
    expect(r.markdown).not.toMatch(/Updating files/);
    expect(r.markdown).not.toMatch(/per-run worktree create failed/);
    expect(r.markdown).not.toMatch(/worktree_timeout/);
    expect(r.markdown).not.toMatch(/RC=/);
    expect(r.markdown).not.toMatch(/_mt_wt_/);
    expect(r.markdown).not.toMatch(/```/);
  };

  it("worktree_timeout (true timeout OR reclassified early infra-kill) → honest cause-agnostic setup copy", () => {
    assertHonestSetup(
      synthesizeErrorBody(
        "worktree_timeout: per-run worktree create failed for run=26df9ecd: " +
          "Preparing worktree\nUpdating files: 42% (2438/6337)",
        "engineer",
      ),
    );
  });

  it("residual worktree_git (real bad ref / lock, RC= present) → SAME honest setup copy, no false 're-send'", () => {
    assertHonestSetup(
      synthesizeErrorBody(
        "per-run worktree create failed for run=x: fatal: invalid reference: origin/main\nRC=128",
        "engineer",
      ),
    );
  });

  it("a worktree failure carrying a DEAD-INSTALL signature still routes to Reconnect (setup RE ordered after)", () => {
    const r = synthesizeErrorBody(
      "per-run worktree create failed for run=x: mintInstallationToken HTTP 404",
      "engineer",
    );
    expect(r.action_link).toMatch(/reauth:github/);
    expect(r.markdown).not.toMatch(/setting up your repository/i);
  });
});

describe("synthesizeErrorBody: large-repo worktree insufficient disk", () => {
  const RAW =
    "worktree_insufficient_disk: per-run worktree create failed for run=abc: " +
    "insufficient_disk: a second working tree needs ~2800MB (tree 2500MB + margin) " +
    "but only 2300MB free on /home/user/repo fs. This repo is too large for the " +
    "current sandbox tier — route it to a larger sandbox.";

  it("worktree_insufficient_disk → honest infra copy, NO 'try again', no plumbing, no action link", () => {
    const r = synthesizeErrorBody(RAW, "engineer");
    expect(r.action_link).toBeNull();
    expect(r.markdown).toMatch(/ran out of room/i);
    expect(r.markdown).not.toMatch(/try again/i);
    expect(r.markdown).not.toMatch(/re-send your message/i);
    expect(r.markdown).not.toMatch(/insufficient_disk/);
    expect(r.markdown).not.toMatch(/```/);
  });

  it("promises NO resize and NO bigger tier — neither exists", () => {
    const r = synthesizeErrorBody(RAW, "engineer");
    expect(r.markdown).not.toMatch(/resiz/i);
    expect(r.markdown).not.toMatch(/larger sandbox|bigger sandbox|larger tier|upgrade/i);
    expect(r.markdown).toMatch(/limit on my end|on our side/i);
  });
});

describe("synthesizeErrorBody: worktree base ref missing (empty repo)", () => {
  const RAW_EMPTY =
    "per-run worktree create failed for run=2a711dc8: Preparing worktree " +
    "(new branch '_mt_wt_2a711dc8')\nfatal: not a valid object name: 'origin/main'\n" +
    "[wt-diag] df:\nFilesystem      Size  Used Avail Use%";

  it("names the real cause and the one action that fixes it", () => {
    const r = synthesizeErrorBody(RAW_EMPTY, "engineer");
    expect(r.markdown).toMatch(/no commits yet/i);
    expect(r.markdown).toMatch(/site build didn't finish/i);
    expect(r.markdown).toMatch(/Retry build/);
  });

  it("does not tell the customer to push a commit themselves", () => {
    const r = synthesizeErrorBody(RAW_EMPTY, "engineer");
    expect(r.markdown).not.toMatch(/push/i);
    expect(r.markdown).not.toMatch(/README/i);
  });

  it("sends a self-connected repo to the GitHub connection, and asks for repo and branch", () => {
    const r = synthesizeErrorBody(RAW_EMPTY, "engineer");
    expect(r.markdown).toMatch(/GitHub connection/);
    expect(r.markdown).toMatch(/which repo and branch to use/);
  });

  it("does NOT tell the customer to retry — retrying can never succeed here", () => {
    const r = synthesizeErrorBody(RAW_EMPTY, "engineer");
    expect(r.markdown).not.toMatch(/try again/i);
    expect(r.markdown).not.toMatch(/in a few minutes/i);
    expect(r.markdown).not.toMatch(/infrastructure issue/i);
  });

  it("beats the generic worktree-setup matcher (both regexes match this string)", () => {
    const r = synthesizeErrorBody(RAW_EMPTY, "engineer");
    expect(r.markdown).toMatch(/branch to work from/i);
  });

  it("also covers a deleted/renamed base branch (couldn't find remote ref)", () => {
    const raw =
      "per-run worktree create failed for run=abc: " +
      "fatal: couldn't find remote ref refs/heads/main";
    const r = synthesizeErrorBody(raw, "engineer");
    expect(r.markdown).toMatch(/which branch to use/i);
    expect(r.markdown).not.toMatch(/try again/i);
    expect(r.markdown).not.toMatch(/no commits/i);
    expect(r.markdown).not.toMatch(/site build/i);
    expect(r.markdown).not.toMatch(/Retry build/);
  });

  it("leaks no git plumbing to the customer", () => {
    const r = synthesizeErrorBody(RAW_EMPTY, "engineer");
    expect(r.markdown).not.toMatch(/fatal:|wt-diag|_mt_wt_|origin\/main/);
    expect(r.markdown).not.toMatch(/```/);
  });

  it("a real worktree TIMEOUT still gets the retry copy (no over-capture)", () => {
    const raw = "worktree_timeout: per-run worktree create failed for run=abc: timed out";
    const r = synthesizeErrorBody(raw, "engineer");
    expect(r.markdown).toMatch(/try again/i);
  });
});
