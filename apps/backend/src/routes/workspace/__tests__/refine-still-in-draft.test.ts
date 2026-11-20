import { describe, it, expect } from "vitest";
import { pendingDraftShasOf, refineStillInDraft } from "@/routes/workspace/autopilot";

const LIVE = { live_edit_branch: "zavi/draft" };
const A = "a".repeat(40);
const B = "b".repeat(40);

describe("refineStillInDraft", () => {
  it("a normal refine is never a draft", () => {
    expect(refineStillInDraft({ refine_mode: true }, { live_edit_draft_sha: A }, new Set([A]))).toBe(false);
  });

  it("a draft refine whose commit is still ahead of main stays a draft", () => {
    expect(refineStillInDraft(LIVE, { live_edit_draft_sha: A }, new Set([A, B]))).toBe(true);
  });

  it("once published (commit no longer ahead of main) it is no longer a draft", () => {
    expect(refineStillInDraft(LIVE, { live_edit_draft_sha: A }, new Set([B]))).toBe(false);
    expect(refineStillInDraft(LIVE, { live_edit_draft_sha: A }, new Set())).toBe(false);
  });

  it("stays a draft when the draft state could not be read, so nothing is claimed live by mistake", () => {
    expect(refineStillInDraft(LIVE, { live_edit_draft_sha: A }, null)).toBe(true);
  });

  it("is unknown, not a draft, when the draft state could not be read but the change has a commit", () => {
    expect(refineStillInDraft(LIVE, { live_edit_draft_sha: A }, null, true)).toBeNull();
    expect(refineStillInDraft(LIVE, null, null, true)).toBe(true);
    expect(refineStillInDraft({ refine_mode: true }, { live_edit_draft_sha: A }, null, true)).toBe(false);
  });

  it("a draft refine still running (no commit yet) is a draft", () => {
    expect(refineStillInDraft(LIVE, null, new Set([B]))).toBe(true);
  });
});

describe("pendingDraftShasOf", () => {
  it("reads the pending commits while live edit is on", () => {
    const shas = pendingDraftShasOf({ enabled: true, draft: { exists: true, changes: [{ sha: A }] } });
    expect(shas).toEqual(new Set([A]));
    expect(refineStillInDraft(LIVE, { live_edit_draft_sha: A }, shas)).toBe(true);
    expect(refineStillInDraft(LIVE, { live_edit_draft_sha: B }, shas)).toBe(false);
  });

  it("treats a switched-off live edit as unknown, so an unpublished draft is never shown as live", () => {
    const shas = pendingDraftShasOf({ enabled: false, draft: { exists: true, changes: [] } });
    expect(shas).toBeNull();
    expect(refineStillInDraft(LIVE, { live_edit_draft_sha: A }, shas)).toBe(true);
  });

  it("treats a deleted draft branch as having no pending commits", () => {
    const shas = pendingDraftShasOf({ enabled: true, draft: { exists: false, changes: [] } });
    expect(shas).toEqual(new Set());
    expect(refineStillInDraft(LIVE, { live_edit_draft_sha: A }, shas)).toBe(false);
  });
});
