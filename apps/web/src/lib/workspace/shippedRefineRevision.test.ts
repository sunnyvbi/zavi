import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { landedRefine, refineShippedSince, shippedRefineRevision, type BuildRefine } from "./useBuildSession";

const r = (id: string, status: string, extra: Partial<BuildRefine> = {}) =>
  ({ id, status, message: id, created_at: "2026-09-29T00:00:00Z", ...extra }) as BuildRefine;

describe("shippedRefineRevision", () => {
  it("is the newest change that actually went live", () => {
    expect(shippedRefineRevision([r("a", "done"), r("b", "done"), r("c", "active")])).toBe("b");
  });

  it("ignores changes that are not on the live app: drafts, parked for review, failed, reverts", () => {
    expect(
      shippedRefineRevision([
        r("a", "done"),
        r("b", "done", { draft: true }),
        r("c", "done", { awaiting_review: true }),
        r("d", "failed"),
        r("e", "done", { kind: "restore" }),
      ]),
    ).toBe("a");
    expect(shippedRefineRevision([])).toBeNull();
  });

  it("ignores a change that changed no code (nothing to change, a question, a refusal): no preview reload", () => {
    expect(
      shippedRefineRevision([
        r("a", "done"),
        r("b", "done", { no_change: true, declared_outcome: "no_change" }),
        r("c", "done", { declared_outcome: "needs_input" }),
        r("d", "done", { declared_outcome: "refused" }),
      ]),
    ).toBe("a");
    expect(landedRefine([r("a", "done"), r("q", "done", { declared_outcome: "needs_input" })])?.id).toBe("a");
  });
});

describe("refineShippedSince", () => {
  it("never reloads on the first look (opening Build over an old change)", () => {
    expect(refineShippedSince(undefined, "a")).toBe(false);
  });

  it("reloads when a new change goes live, including the very first one", () => {
    expect(refineShippedSince("a", "b")).toBe(true);
    expect(refineShippedSince(null, "a")).toBe(true);
  });

  it("does not reload on polls where nothing new shipped", () => {
    expect(refineShippedSince("a", "a")).toBe(false);
    expect(refineShippedSince("a", null)).toBe(false);
  });
});

describe("AppWorkspace wiring", () => {
  it("reloads the preview when a change ships, from the live-app view's own refine feed", () => {
    const src = readFileSync(join(__dirname, "../../components/workspace/WebsiteTab.tsx"), "utf-8");
    expect(src).toMatch(/const shippedRevision = isBuild \? shippedRefineRevision\(buildConversation\.refines\) : null;/);
    expect(src).toMatch(/if \(refineShippedSince\(prev, shippedRevision\)\) refreshPreviewAfterRun\(\);/);
  });
});
