
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardState } from "./dashboard-ui";

let mockState: DashboardState<unknown>;
vi.mock("./dashboard-ui", async () => {
  const actual = await vi.importActual<typeof import("./dashboard-ui")>(
    "./dashboard-ui",
  );
  return {
    ...actual,
    useAgentDashboard: () => mockState,
  };
});

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
}));

vi.mock("@/lib/workspace/useRealtimeChannel", () => ({
  useRealtimeChannel: vi.fn(),
}));

vi.mock("@/components/workspace/WorkspaceShell", () => ({
  useWorkspace: () => ({ openTab: () => {} }),
}));

vi.mock("../Markdown", () => ({
  Markdown: ({ source }: { source: string }) => source,
}));

vi.mock("../CollapsibleMarkdown", () => ({
  CollapsibleMarkdown: ({ children }: { children: unknown }) => children,
}));

import { ContentDesignDashboard } from "./ContentDesignDashboard";

const SOURCE = readFileSync(
  join(__dirname, "ContentDesignDashboard.tsx"),
  "utf-8",
);

function stateOf(data: unknown): DashboardState<unknown> {
  return {
    data,
    loading: false,
    refreshing: false,
    error: null,
    refresh: () => {},
    newRowIds: new Set<string>(),
  };
}

function payload(over: Record<string, unknown> = {}) {
  return {
    generic: false,
    refreshed_at: "2026-06-23T21:00:00.000Z",
    kpis: {
      prs_opened: 0,
      pending: 0,
      drafted_last_30d: 11,
      last_draft_at: "2026-06-16T12:00:00.000Z",
    },
    has_publish_target: true,
    attention: [],
    queue: [
      {
        id: "decision-1",
        source: "decision",
        title: "What Is Peer-to-Peer Car Rental? A Guide for Hosts and Renters",
        target_keyword: "peer-to-peer car rental",
        change_type: "new_blog_post",
        file_action: "create",
        status: "proposed",
        emitted_at: "2026-06-23T12:00:00.000Z",
        expires_at: "2026-06-30T12:00:00.000Z",
        path: "content/blog/what-is-peer-to-peer-car-rental.md",
        repo: "upcar/site",
        base_branch: "main",
        head_branch: "product-builder/content-seo-peer-to-peer",
        recommendation_markdown: "**Recommendation — new SEO post**",
        draft_markdown:
          "FULL DRAFT BODY SHOULD STAY HIDDEN UNTIL THE PROPOSAL IS EXPANDED",
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  mockState = stateOf(payload());
});

describe("ContentDesignDashboard — teammate standup pipeline", () => {
  it("starts the audit through chat enqueue, not the blocked manual run endpoint", () => {
    expect(SOURCE).toContain("`/api/agents/${SLUG}/chat`");
    expect(SOURCE).not.toContain("`/api/agents/${SLUG}/run`");
  });

  it("shows the persistent truth strip about no metrics + PR-only publish", () => {
    const html = renderToStaticMarkup(<ContentDesignDashboard />);
    expect(html).toContain("No analytics connected");
    expect(html).toContain("impact is my estimate");
    expect(html).toContain("I open a pull request. You review and merge it");
    expect(html).toContain("I never publish on my own");
  });

  it("leads with a plain-language standup summary instead of a KPI grid", () => {
    const html = renderToStaticMarkup(<ContentDesignDashboard />);
    expect(html).toContain("I reviewed your whole product.");
    expect(html).toContain("thing needs your OK");
    expect(html).toContain("areas checked");
    expect(html).not.toContain("WAITING");
    expect(html).not.toContain("Needs decision");
    expect(html).not.toContain("Proposal queue");
  });

  it("frames a proposal as a teammate ask with plain status + honest CTA", () => {
    const html = renderToStaticMarkup(<ContentDesignDashboard />);

    expect(html).toContain("Content design");
    expect(html).toContain("Run a content-design review");
    expect(html).toContain("Run review");
    expect(html).toContain("Needs your OK: pick the ones to ship");
    expect(html).toContain("New blog post proposal");
    expect(html).toContain(
      "What Is Peer-to-Peer Car Rental? A Guide for Hosts and Renters",
    );
    expect(html).toContain(
      "I drafted this and need your OK before I open a PR. Please review by Jun 30, 2026.",
    );
    expect(html).toContain("Needs your OK");
    expect(html).toContain("Why: a common question with no clear answer");
    expect(html).toContain("Review it in Needs you");
    expect(html).toContain("Create content/blog/what-is-peer-to-peer-car-rental.md");
    expect(html).not.toContain(
      "FULL DRAFT BODY SHOULD STAY HIDDEN UNTIL THE PROPOSAL IS EXPANDED",
    );
  });

  it("never calls an opened PR published or live, and asks the founder to merge it", () => {
    const base = payload().queue[0];
    mockState = stateOf(
      payload({
        queue: [
          { ...base, id: "decision-acted", status: "acted", title: "Opened PR row" },
          { ...base, id: "decision-approved", status: "approved", title: "Approved row" },
        ],
      }),
    );
    const html = renderToStaticMarkup(<ContentDesignDashboard />);
    expect(html).toContain("Opened PR row");
    expect(html).toContain("PR open");
    expect(html).toContain("Opening PR");
    expect(html).toContain("In motion: PRs for you to merge (2)");
    expect(html).not.toMatch(/Published|it(&#x27;|')s live|this one is live/);
  });

  it("frames existing page improvements as modifications, not blog posts", () => {
    mockState = stateOf(
      payload({
        queue: [
          {
            id: "decision-2",
            source: "decision",
            title: "Improve the Host Landing Page",
            target_keyword: "rent out my car",
            change_type: "improve_existing_page",
            file_action: "modify",
            status: "proposed",
            emitted_at: "2026-06-23T18:00:00.000Z",
            expires_at: "2026-06-30T18:00:00.000Z",
            path: "content/pages/hosts.mdx",
            repo: "upcar/site",
            base_branch: "main",
            head_branch: "product-builder/content-seo-hosts",
            recommendation_markdown: "**Recommendation — existing page improvement**",
            draft_markdown: "FULL HOST PAGE BODY SHOULD STAY HIDDEN",
          },
        ],
      }),
    );
    const html = renderToStaticMarkup(<ContentDesignDashboard />);

    expect(html).toContain("Existing page improvement");
    expect(html).toContain("Improve the Host Landing Page");
    expect(html).toContain(
      "Improve existing content for people who want &quot;rent out my car&quot;",
    );
    expect(html).toContain("Why: an existing page can be clearer or better structured");
    expect(html).toContain("Modify content/pages/hosts.mdx");
    expect(html).not.toContain("New blog post proposal");
    expect(html).not.toContain("FULL HOST PAGE BODY SHOULD STAY HIDDEN");
  });

  it("moves expired proposals out of the standup into folded earlier work", () => {
    mockState = stateOf(
      payload({
        queue: [
          {
            id: "decision-archived",
            source: "decision",
            title: "What Is Peer-to-Peer Car Rental? A Guide for Hosts and Renters",
            target_keyword: "peer-to-peer car rental",
            change_type: "new_blog_post",
            file_action: "create",
            status: "expired",
            emitted_at: "2026-06-10T12:00:00.000Z",
            expires_at: "2026-06-17T12:00:00.000Z",
            path: "content/blog/what-is-peer-to-peer-car-rental.md",
            repo: "upcar/site",
            base_branch: "main",
            head_branch: "product-builder/content-seo-peer-to-peer",
            recommendation_markdown: "**Recommendation — new SEO post**",
            draft_markdown: "OLD BLOG BODY",
          },
        ],
      }),
    );
    const html = renderToStaticMarkup(<ContentDesignDashboard />);

    expect(html).toContain("Run review");
    expect(html).toContain("Nothing needs your OK right now");
    expect(html).toContain("Earlier work");
    expect(html).toContain("Expired");
    expect(html).not.toContain("OLD BLOG BODY");
  });

  it("reframes a drafted-but-unqueued recovery row honestly, not as enum plumbing", () => {
    mockState = stateOf(
      payload({
        queue: [
          {
            id: "run-1:insurance",
            source: "run",
            run_id: "run-1",
            title: "Insurance for P2P car rental hosts",
            target_keyword: "p2p car rental insurance",
            change_type: "new_blog_post",
            file_action: "create",
            status: "drafted_unqueued",
            emitted_at: "2026-06-20T12:00:00.000Z",
            expires_at: null,
            path: "content/blog/insurance-for-p2p-hosts.md",
            repo: null,
            base_branch: null,
            head_branch: null,
            recommendation_markdown: "**Recommendation — recovered SEO draft**",
            draft_markdown: "RECOVERED DRAFT BODY STAYS HIDDEN",
          },
        ],
      }),
    );
    const html = renderToStaticMarkup(<ContentDesignDashboard />);

    expect(html).toContain("Needs refresh");
    expect(html).toContain("package for approval");
    expect(html).toContain("package it for approval");
    expect(html).toContain("Ask me to refresh");
    expect(html).not.toContain("drafted_unqueued");
    expect(html).not.toContain("no approval card was created");
    expect(html).not.toContain("RECOVERED DRAFT BODY STAYS HIDDEN");
  });

  it("turns stale unqueued-draft attention into the audit command, not a chat nudge", () => {
    mockState = stateOf(
      payload({
        queue: [],
        attention: [
          {
            severity: "warn",
            title: "6 drafted content improvements not queued for approval",
            detail: "6 recent drafts never became approval cards.",
            ask: "Ask in chat -> Run a fresh full-site content audit.",
          },
        ],
      }),
    );
    const html = renderToStaticMarkup(<ContentDesignDashboard />);

    expect(html).toContain("Run a content-design review");
    expect(html).toContain("Run review");
    expect(html).not.toContain("6 drafted content improvements not queued for approval");
    expect(html).not.toContain("Ask in chat");
  });

  it("uses the shared run-loading screen while a full-site audit is active", () => {
    mockState = stateOf(
      payload({
        agent_slug: "content-seo",
        active_run: {
          run_id: "run-content-audit",
          status: "running",
          enqueued_at: "2026-06-23T22:00:00.000Z",
          started_at: "2026-06-23T22:00:05.000Z",
        },
      }),
    );
    const html = renderToStaticMarkup(<ContentDesignDashboard />);

    expect(html).toContain("Running content-design review");
    expect(html).toContain("Reviewing product surfaces");
    expect(html).toContain("Finding user needs and content gaps");
    expect(html).toContain("Preparing approval-ready proposals");
    expect(html).toContain("After this finishes");
    expect(html).not.toContain("Needs your OK: pick the ones to ship");
  });

  it("explains the approval-to-PR handoff without expanding the draft body", () => {
    const html = renderToStaticMarkup(<ContentDesignDashboard />);

    expect(html).toContain("How this works");
    expect(html).toContain("I review your content");
    expect(html).toContain("I propose a change for a user need");
    expect(html).toContain("A PR opens");
    expect(html).toContain("You merge to publish");
    expect(html).toContain(
      "Approved proposals open a PR adding or modifying markdown/MDX content",
    );
    expect(html).toContain("I never merge or auto-publish");
    expect(html).not.toContain(
      "FULL DRAFT BODY SHOULD STAY HIDDEN UNTIL THE PROPOSAL IS EXPANDED",
    );
  });

  it("uses an honest empty state when no proposals need an OK", () => {
    mockState = stateOf(payload({ queue: [] }));
    const html = renderToStaticMarkup(<ContentDesignDashboard />);

    expect(html).toContain("Nothing needs your OK right now");
    expect(html).toContain("Run review");
    expect(html).toContain("Areas I checked");
    expect(html).toContain("How this works");
  });

  it("marks surfaces as checked after an audit completes with no findings", () => {
    mockState = stateOf(
      payload({
        last_audit_at: "2026-06-23T22:55:00.000Z",
        kpis: {
          prs_opened: 0,
          pending: 0,
          drafted_last_30d: 0,
          last_draft_at: null,
        },
        queue: [],
      }),
    );
    const html = renderToStaticMarkup(<ContentDesignDashboard />);

    expect(html).toContain("I checked 6 areas");
    expect(html).toContain("Areas I checked");
    expect(html).toContain("Checked, nothing to change");
    expect(html).not.toContain("Not audited yet");
  });
});
