import { describe, it, expect } from "vitest";
import { builderUndoOutcome } from "./BuilderChatCard";

const PROVISIONED = /provisioned repo/i;

describe("BuilderChatCard undo copy (DEL-1323 B29)", () => {
  it.each([
    [403, "forbidden", "Viewers can't undo changes. Ask a workspace owner, admin or member."],
    [403, "product_builder_disabled", "Changing your app is turned off right now, so nothing was undone."],
    [409, "newer_change", "This change can't be undone any more, because your app changed after it."],
    [409, "build_in_progress", "Wait for the change that's running to finish, then try again."],
    [409, "undo_in_progress", "This change is already being undone."],
    [409, "unpublished_draft", "Your preview has edits that aren't published yet. Publish or discard them, then try again."],
    [
      409,
      "undo_commit_not_found",
      "We couldn't find the saved version of this change, so it can't be undone from here. Your site hasn't changed.",
    ],
    [409, "draft_not_published", "This change isn't live yet, so there is nothing to undo."],
    [404, "no_undoable_refine", "This change can't be undone any more, because a newer change or undo came after it."],
  ])("%i %s gets the Build pane's copy, never the provisioned-repo line", (status, code, copy) => {
    const out = builderUndoOutcome(status, { error: { code } });
    expect(out).toEqual({ error: copy, notice: null });
    expect(out.error).not.toMatch(PROVISIONED);
  });

  it("only a real not_provisioned refusal talks about the app's setup", () => {
    expect(builderUndoOutcome(409, { error: { code: "not_provisioned" } })).toEqual({
      error: "Undo isn't available for this app.",
      notice: null,
    });
  });

  it("an unknown failure is a plain retry line, not a raw server message", () => {
    expect(builderUndoOutcome(500, { error: { code: "refine_undo_failed" } })).toEqual({
      error: "Couldn't undo this change. Try again.",
      notice: null,
    });
  });

  it("a landed undo that did not republish says so as a notice, never as an error", () => {
    expect(builderUndoOutcome(200, { republished: false, draft_reset: true })).toEqual({
      error: null,
      notice: "The change was undone, but the live site didn't update. Publish your site again to put the undo live.",
    });
    expect(builderUndoOutcome(200, { republished: false, republish_pending: true, draft_reset: true })).toEqual({
      error: null,
      notice: "The change was undone. Your live site will update within a few minutes.",
    });
    expect(builderUndoOutcome(200, { republished: true, draft_reset: false })).toEqual({
      error: null,
      notice: "Your preview may still show the old change. Discard the preview draft before your next edit.",
    });
  });

  it("a 403 with an unknown code is not blamed on the caller's role", () => {
    expect(builderUndoOutcome(403, { error: { code: "role_check_failed" } }).error).toBe(
      "Couldn't undo this change. Try again.",
    );
    expect(builderUndoOutcome(403, null).error).not.toMatch(/owners and admins/);
  });

  it("a clean undo has no message", () => {
    expect(builderUndoOutcome(200, { republished: true, draft_reset: true })).toEqual({ error: null, notice: null });
    expect(builderUndoOutcome(200, null)).toEqual({ error: null, notice: null });
  });
});
