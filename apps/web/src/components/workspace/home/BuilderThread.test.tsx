import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BuilderThread,
  type BuilderTurn,
  relativeTime,
  refineStatusBadge,
} from "./BuilderThread";

const buildTurn: BuilderTurn = {
  kind: "build",
  id: "build-1",
  message: "A waitlist landing page for a coffee subscription",
  status: "live",
  created_at: new Date(Date.now() - 60_000).toISOString(),
};

const refineTurn1: BuilderTurn = {
  kind: "refine",
  id: "refine-1",
  message: "Add a contact email field",
  status: "done",
  created_at: new Date(Date.now() - 30_000).toISOString(),
  summary: "Added an email input + validation to the signup form.",
  pr_url: null,
  files: [
    { path: "src/components/SignupForm.tsx", action: "modify" },
    { path: "src/lib/validate.ts", action: "create" },
  ],
};

const refineTurnParked: BuilderTurn = {
  kind: "refine",
  id: "refine-3",
  message: "Add an analytics dashboard",
  status: "done",
  created_at: new Date(Date.now() - 20_000).toISOString(),
  summary: "Wired a metrics page.",
  pr_url: "https://github.com/acme/app/pull/2",
  files: [{ path: "src/Analytics.tsx", action: "create" }],
};

const refineTurn2: BuilderTurn = {
  kind: "refine",
  id: "refine-2",
  message: "Make the hero darker",
  status: "active",
  created_at: new Date(Date.now() - 5_000).toISOString(),
  summary: null,
  pr_url: null,
};

describe("BuilderThread", () => {
  it("renders the original build prompt AND refine turns in ONE continuous thread", () => {
    const html = renderToStaticMarkup(
      <BuilderThread
        turns={[buildTurn, refineTurn1, refineTurn2]}
        loading={false}
        latestShippedRefineId="refine-1"
      />,
    );
    expect(html.match(/<ol/g)?.length).toBe(1);
    expect(html).toContain("A waitlist landing page for a coffee subscription");
    expect(html).toContain("First build");
    expect(html).toContain("Add a contact email field");
    expect(html).toContain("Make the hero darker");
    expect(html.match(/<li/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('data-turn-kind="build"');
    expect(html).toContain('data-turn-kind="refine"');
    const buildIdx = html.indexOf("A waitlist landing page");
    const refine1Idx = html.indexOf("Add a contact email field");
    const refine2Idx = html.indexOf("Make the hero darker");
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeLessThan(refine1Idx);
    expect(refine1Idx).toBeLessThan(refine2Idx);
  });

  it("renders status pills for both build (Live) and refine (Shipped / Working) turns", () => {
    const html = renderToStaticMarkup(
      <BuilderThread
        turns={[buildTurn, refineTurn1, refineTurn2]}
        loading={false}
        latestShippedRefineId="refine-1"
      />,
    );
    expect(html).toContain("Live");
    expect(html).toContain("Shipped");
    expect(html).toContain("Working…");
  });

  it("shows Undo on the latest DIRECT-MERGE shipped refine, and the changelog of changed files", () => {
    const html = renderToStaticMarkup(
      <BuilderThread
        turns={[buildTurn, refineTurn1, refineTurn2]}
        loading={false}
        latestShippedRefineId="refine-1"
      />,
    );
    expect(html).toContain("Undo");
    expect(html).toContain("Changed 2 files");
    expect(html).toContain("src/components/SignupForm.tsx");
    expect(html).toContain("modify");
    expect(html).toContain("src/lib/validate.ts");
    expect(html).toContain("create");
    expect(html).toContain("Added an email input + validation to the signup form.");
  });

  it("shows the PR merge link (not Undo) on a `done` refine that only parked a review PR", () => {
    const html = renderToStaticMarkup(
      <BuilderThread
        turns={[buildTurn, refineTurnParked]}
        loading={false}
        latestShippedRefineId="refine-3"
      />,
    );
    expect(html).toContain("Parked for Zavi to publish");
    expect(html).not.toContain("open PR to merge");
    expect(html).not.toContain("https://github.com/acme/app/pull/2");
    expect(html).toContain("Ready to review");
    expect(html).not.toContain(">Undo<");
  });

  it("attaches the deploy record + Undo to the merged refine, NOT a newer parked review PR", () => {
    const merged: BuilderTurn = {
      kind: "refine",
      id: "refine-merged",
      message: "Ship the pricing page",
      status: "done",
      created_at: new Date(Date.now() - 40_000).toISOString(),
      summary: "Shipped pricing.",
      pr_url: "https://github.com/acme/app/pull/1",
    };
    const parkedNewer: BuilderTurn = {
      kind: "refine",
      id: "refine-parked",
      message: "Add a blog",
      status: "done",
      created_at: new Date(Date.now() - 10_000).toISOString(),
      summary: "Opened a PR.",
      pr_url: "https://github.com/acme/app/pull/2",
    };
    const deploy = {
      state: "deploy_healthy" as const,
      pr_url: "https://github.com/acme/app/pull/1",
      merged_sha: "abc1234",
      served_sha: "abc1234",
      health_url: "https://acme-app.onrender.com",
      reason: null,
      merged_at: null,
      updated_at: null,
      rollback_available: true,
    };
    const html = renderToStaticMarkup(
      <BuilderThread
        turns={[merged, parkedNewer]}
        loading={false}
        latestShippedRefineId="refine-merged"
        deployTargetRefineId="refine-merged"
        deploy={deploy}
      />,
    );
    expect(html.match(/data-deploy-state/g)?.length).toBe(1);
    expect(html.match(/>Undo</g)?.length).toBe(1);
    const parkedIdx = html.indexOf('data-refine-id="refine-parked"');
    const parkedCard = html.slice(parkedIdx);
    expect(parkedCard).not.toContain(">Undo<");
    expect(parkedCard).not.toContain("data-deploy-state");
  });

  it("does NOT show Undo when there is no shipped refine (e.g. only build + in-flight)", () => {
    const html = renderToStaticMarkup(
      <BuilderThread
        turns={[buildTurn, refineTurn2]}
        loading={false}
        latestShippedRefineId={null}
      />,
    );
    expect(html).not.toContain(">Undo<");
  });

  it("renders the build-only empty thread (build turn, no refines yet)", () => {
    const html = renderToStaticMarkup(
      <BuilderThread
        turns={[buildTurn]}
        loading={false}
        latestShippedRefineId={null}
      />,
    );
    expect(html.match(/<ol/g)?.length).toBe(1);
    expect(html).toContain("A waitlist landing page for a coffee subscription");
    expect(html).toContain("First build");
    expect(html).not.toContain('data-turn-kind="refine"');
  });

  it("shows the pre-build empty-state nudge when there are no turns at all", () => {
    const html = renderToStaticMarkup(
      <BuilderThread turns={[]} loading={false} latestShippedRefineId={null} />,
    );
    expect(html).toContain("Describe the app you want below");
    expect(html).not.toContain("<ol");
  });

  it("shows a loading line before the first fetch resolves", () => {
    const html = renderToStaticMarkup(
      <BuilderThread turns={[]} loading={true} latestShippedRefineId={null} />,
    );
    expect(html).toContain("Loading your builder conversation…");
  });
});

describe("relativeTime", () => {
  it("formats seconds / minutes / hours / days", () => {
    const now = Date.now();
    expect(relativeTime(new Date(now - 5_000).toISOString())).toMatch(/\ds ago/);
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString())).toMatch(/\dm ago/);
    expect(relativeTime(new Date(now - 5 * 3_600_000).toISOString())).toMatch(/\dh ago/);
    expect(relativeTime(new Date(now - 5 * 86_400_000).toISOString())).toMatch(/\dd ago/);
  });
  it("falls back to the raw string on an unparseable timestamp", () => {
    expect(relativeTime("not-a-date")).toBe("not-a-date");
  });
});

describe("refineStatusBadge", () => {
  it("maps the real conductor statuses to labels", () => {
    expect(refineStatusBadge("done").label).toBe("Shipped");
    expect(refineStatusBadge("failed").label).toBe("Failed");
    expect(refineStatusBadge("halted").label).toBe("Stopped");
    expect(refineStatusBadge("active").label).toBe("Working…");
    expect(refineStatusBadge("provisioning").label).toBe("Working…");
    expect(refineStatusBadge("proposed").label).toBe("Queued");
  });
  it("capitalizes an unknown status string as the label (forward-compat)", () => {
    expect(refineStatusBadge("mystery_state").label).toBe("Mystery_state");
  });
});

describe("empty state vs a hidden composer", () => {
  it("nudges toward the composer when there is one", () => {
    const html = renderToStaticMarkup(
      <BuilderThread turns={[]} loading={false} latestShippedRefineId={null} />,
    );
    expect(html).toContain("Describe the app you want below");
  });

  it("says nothing when the composer is hidden", () => {
    const html = renderToStaticMarkup(
      <BuilderThread
        turns={[]}
        loading={false}
        latestShippedRefineId={null}
        inviteBuild={false}
      />,
    );
    expect(html).not.toContain("Describe the app you want");
  });
});
