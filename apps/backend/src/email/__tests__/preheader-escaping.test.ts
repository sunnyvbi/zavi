import { describe, expect, it } from "vitest";
import { renderEmail, ZAVI_POSTAL_ADDRESS } from "../theme";
import { renderWelcomeEmail } from "../templates/welcome";
import { renderWelcomeBuildEmail } from "../templates/welcome-build";
import { renderBuildNotStartedEmail } from "../templates/build-not-started";
import { renderBuildLiveEmail } from "../templates/build-live";
import { renderPreviewReadyEmail } from "../templates/preview-ready";
import { renderAppInviteEmail } from "../templates/app-invite";
import {
  renderStartCardConfirmEmail,
  renderStartCardReadyEmail,
  renderStartCardRemoveEmail,
} from "../templates/start-card";
import { renderCreatorNotificationEmail } from "../templates/creator-notification";
import { renderAgentResultEmail } from "../templates/agent-result";
import { renderCgoNoteEmail } from "../templates/cgo-note";
import { renderMorningDigestEmail } from "../templates/morning-digest";
import { renderWorkspaceInviteEmail } from "../templates/workspace-invite";
import { renderMentionAlert } from "../sendMentionAlert";

const RAW = "A&B <Co>";
const ONCE = "A&amp;B &lt;Co&gt;";
const preheaderOf = (html: string) => /<div style="display:none;[^"]*">([^<]*)<\/div>/.exec(html)?.[1] ?? "";

const url = "https://www.zaviagent.com/workspace";
const cases: Array<[string, () => string]> = [
  ["renderEmail itself", () => renderEmail({ title: "t", body: "", preheader: RAW, footerVariant: "neutral" })],
  ["welcome", () => renderWelcomeEmail({ displayName: RAW, workspaceUrl: url }).html],
  ["welcome-build", () => renderWelcomeBuildEmail({ displayName: RAW, buildUrl: url }).html],
  ["build-not-started", () => renderBuildNotStartedEmail({ displayName: RAW, workspaceUrl: url, reason: "r" }).html],
  ["build-live", () => renderBuildLiveEmail({ siteName: RAW, liveUrl: url, workspaceUrl: url }).html],
  [
    "preview-ready",
    () =>
      renderPreviewReadyEmail({ displayName: RAW, total: 2, channelNames: ["Reddit"], planName: "Starter", planUsd: 20, channelsUrl: url })
        .html,
  ],
  ["app-invite", () => renderAppInviteEmail({ inviteUrl: url, siteHost: RAW, role: "user", expiresAt: "2026-10-09T00:00:00Z" }).html],
  ["start-card confirm", () => renderStartCardConfirmEmail({ domain: RAW, confirmUrl: url }).html],
  ["start-card ready", () => renderStartCardReadyEmail({ domain: RAW, strategyUrl: url }).html],
  ["start-card remove", () => renderStartCardRemoveEmail({ domain: RAW, removeUrl: url }).html],
  ["creator-notification", () => renderCreatorNotificationEmail({ title: "New message", intro: RAW }).html],
  ["agent-result", () => renderAgentResultEmail({ agentSlug: "operator", runUrl: url, body: RAW }).html],
  [
    "cgo-note",
    () => renderCgoNoteEmail({ companyName: "Acme", autopilot: true, growthUrl: url, saw: [], changed: [], need: [RAW] }).html,
  ],
  [
    "morning-digest",
    () =>
      renderMorningDigestEmail(
        {
          yesterday: { builds_started: 0, builds_done: 0, builds_failed: 0, spend_usd: 0, pr_count: 0 },
          today: { proposed_plans: 0, pending_suggestions: 0, pending_approvals: 1 },
          goals: [],
          recent_activity: [],
          top_decisions: [{ id: "d1", title: RAW, risk: "low" }],
        } as unknown as Parameters<typeof renderMorningDigestEmail>[0],
        { workspaceUrl: url, approvalsUrl: url },
      ).html,
  ],
  ["workspace-invite", () => renderWorkspaceInviteEmail({ actionUrl: url, inviterLabel: "Priya", tenantName: RAW }).html],
  [
    "mention alert",
    () =>
      renderMentionAlert([
        { channelLabel: "Reddit", title: RAW, excerpt: "x", url, context: "c", sentiment: null },
      ]).html,
  ],
];

describe("the preheader is escaped exactly once, by renderEmail", () => {
  for (const [name, render] of cases) {
    it(name, () => {
      const pre = preheaderOf(render());
      expect(pre).toContain(ONCE);
      expect(pre).not.toContain("&amp;amp;");
      expect(pre).not.toContain("&amp;lt;");
      expect(pre).not.toContain("<Co>");
    });
  }
});

describe("the morning digest greeting is user-typed and lands in HTML", () => {
  it("escapes the display name in the intro", () => {
    const r = renderMorningDigestEmail(
      {
        yesterday: { builds_started: 0, builds_done: 0, builds_failed: 0, spend_usd: 0, pr_count: 0 },
        today: { proposed_plans: 0, pending_suggestions: 0, pending_approvals: 0 },
        goals: [],
        recent_activity: [],
      } as unknown as Parameters<typeof renderMorningDigestEmail>[0],
      { workspaceUrl: url, approvalsUrl: url, displayName: "<b>Ravi</b> & co" },
    );
    expect(r.html).toContain("Good morning &lt;b&gt;Ravi&lt;/b&gt; &amp; co.");
    expect(r.html).not.toContain("<b>Ravi</b>");
  });
});

describe("the footer", () => {
  it("carries the help address and the mailing address with no dashes, and only founder-growth emails carry the founder line", () => {
    const founder = renderEmail({ title: "t", body: "", footerVariant: "founder-growth" });
    const neutral = renderEmail({ title: "t", body: "", footerVariant: "neutral" });
    for (const html of [founder, neutral]) {
      expect(html).toContain("mailto:support@zaviagent.com");
      expect(html).toContain(ZAVI_POSTAL_ADDRESS);
      expect(html).not.toMatch(/&mdash;|&ndash;|[\u2013\u2014]/);
    }
    expect(founder).toContain("Your growth, run by Zavi.");
    expect(neutral).not.toContain("Your growth, run by Zavi.");
  });

  it("each email sits on the right side of the founder line", () => {
    const has = (html: string) => html.includes("Your growth, run by Zavi.");
    expect(has(renderWelcomeEmail({ displayName: "Acme", workspaceUrl: url }).html)).toBe(true);
    expect(has(renderBuildLiveEmail({ siteName: "Acme", liveUrl: url, workspaceUrl: url }).html)).toBe(true);
    expect(has(renderWorkspaceInviteEmail({ actionUrl: url, inviterLabel: "Priya", tenantName: "Acme" }).html)).toBe(false);
    expect(has(renderAppInviteEmail({ inviteUrl: url, siteHost: "acme.com", role: "user", expiresAt: "" }).html)).toBe(false);
    expect(has(renderStartCardConfirmEmail({ domain: "acme.com", confirmUrl: url }).html)).toBe(false);
    expect(has(renderStartCardReadyEmail({ domain: "acme.com", strategyUrl: url }).html)).toBe(false);
    expect(has(renderCreatorNotificationEmail({ title: "Hired", intro: "x" }).html)).toBe(false);
    expect(has(renderAgentResultEmail({ agentSlug: "operator", runUrl: url, body: "x" }).html)).toBe(false);
  });
});
