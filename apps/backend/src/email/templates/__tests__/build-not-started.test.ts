
import { describe, it, expect } from "vitest";
import { renderBuildNotStartedEmail } from "../build-not-started";
import { renderWelcomeBuildEmail } from "../welcome-build";

const base = { displayName: "Acme", workspaceUrl: "https://www.zaviagent.com/workspace" };

const REAL_CREDIT_REASON =
  "This build needs about 4,320 credits and your workspace has 1,000 credits.";

describe("build-not-started email", () => {
  it("states only what is true: workspace yes, build no, no INFRA, no charge", () => {
    const r = renderBuildNotStartedEmail({ ...base, reason: "not enough credits" });
    expect(r.subject).toContain("Acme");
    expect(r.text).toContain("workspace is set up");
    expect(r.text).toContain("did not start a build");
    expect(r.text).toMatch(/no repo, database or hosting was created/);
    expect(r.text).toContain("no credits were spent");
    expect(r.html).not.toContain("Your app is <em>building</em>");
    expect(r.text).not.toMatch(/we're building/i);
  });

  it("never claims nothing was created — the TENANT was created", () => {
    const r = renderBuildNotStartedEmail({ ...base, reason: "not enough credits" });
    expect(r.text).not.toMatch(/nothing was created/i);
    expect(r.html).not.toMatch(/nothing was created/i);
  });

  it("never tells the founder to just retry the build", () => {
    const r = renderBuildNotStartedEmail({ ...base, reason: "not enough credits" });
    expect(r.text).not.toMatch(/start the build from there/i);
    expect(r.text).not.toMatch(/try again/i);
    expect(r.html).not.toMatch(/start the build from there/i);
  });

  it("but DOES pass through the server's own next step, even when it says retry", () => {
    const r = renderBuildNotStartedEmail({
      ...base,
      reason: "daily build limit reached (10/10 builds today) — try again tomorrow",
    });
    expect(r.text).toContain("try again tomorrow");
    expect(r.html).toContain("try again tomorrow");
  });

  it("passes the server's curated reason through to the founder", () => {
    const reason =
      "not enough credits to finish this build: it needs about 4,320 credits ($10.80) and this workspace has 1,000 left.";
    const r = renderBuildNotStartedEmail({ ...base, reason });
    expect(r.text).toContain("4,320");
    expect(r.html).toContain("4,320");
  });

  it("escapes a hostile company name instead of emitting it as markup", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const r = renderBuildNotStartedEmail({ displayName: evil, workspaceUrl: base.workspaceUrl, reason: "nope" });
    expect(r.html).not.toContain("<img src=x");
    expect(r.html).toContain("&lt;img src=x");

    const w = renderWelcomeBuildEmail({ displayName: evil, buildUrl: base.workspaceUrl });
    expect(w.html).not.toContain("<img src=x");
    expect(w.html).toContain("&lt;img src=x");
  });

  it("escapes a hostile reason too", () => {
    const r = renderBuildNotStartedEmail({ ...base, reason: '<script>alert(1)</script>' });
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("does not mangle a legitimate punctuated name", () => {
    const r = renderBuildNotStartedEmail({
      displayName: "Ben & Jerry's",
      workspaceUrl: base.workspaceUrl,
      reason: "not enough credits",
    });
    expect(r.html).toContain("Ben &amp; Jerry&#39;s");
    expect(r.html).not.toContain("Ben & Jerry's</");
    expect(r.text).toContain("Ben & Jerry's");
    expect(r.text).not.toContain("&amp;");
    expect(r.subject).toContain("Ben & Jerry's");
    expect(r.subject).not.toContain("&amp;");
  });
});
