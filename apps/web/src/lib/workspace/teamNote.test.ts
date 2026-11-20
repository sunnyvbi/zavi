import { describe, it, expect, vi, beforeEach } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch }));

import { markTeamNoteShown, parseOfferedTeamNote, pickStripNote, type OfferedTeamNote } from "./teamNote";

const draft = { offer_id: "o1", note: "The ads tool failed twice.", signal: "tool_failure", offer_stop: false };

describe("parseOfferedTeamNote", () => {
  it("reads a drafted strip note with its anchor", () => {
    expect(parseOfferedTeamNote({ id: "m1", meta: { team_note_draft: { ...draft, surface: "strip", anchor_message_id: "u2" }, team_note_state: "drafted" } }))
      .toEqual({ messageId: "m1", offerId: "o1", note: "The ads tool failed twice.", offerStop: false, state: "drafted", surface: "strip", anchorMessageId: "u2" });
  });
  it("reads a shown note with offer_stop", () => {
    expect(parseOfferedTeamNote({ id: "m1", meta: { team_note_draft: { ...draft, offer_stop: true }, team_note_state: "shown" } })?.offerStop).toBe(true);
  });
  it("a note from before surfaces existed (no surface, no anchor) is a flag", () => {
    expect(parseOfferedTeamNote({ id: "m1", meta: { team_note_draft: draft, team_note_state: "drafted" } }))
      .toMatchObject({ surface: "flag", anchorMessageId: null });
  });
  it("a strip with no anchor is a flag (never a strip it cannot place)", () => {
    expect(parseOfferedTeamNote({ id: "m1", meta: { team_note_draft: { ...draft, surface: "strip", anchor_message_id: null }, team_note_state: "drafted" } }))
      .toMatchObject({ surface: "flag", anchorMessageId: null });
  });
  it.each(["sent", "dismissed", "suppressed", "weird"])("null for state %s", (s) => {
    expect(parseOfferedTeamNote({ id: "m1", meta: { team_note_draft: draft, team_note_state: s } })).toBeNull();
  });
  it.each([null, { id: "m1", meta: null }, { id: "m1", meta: { team_note_draft: { note: "" }, team_note_state: "drafted" } }, { id: "", meta: { team_note_draft: draft, team_note_state: "drafted" } }])(
    "null on any doubt: %j",
    (row) => expect(parseOfferedTeamNote(row as never)).toBeNull(),
  );
});

describe("pickStripNote", () => {
  const n = (messageId: string, surface: "strip" | "flag", anchor: string | null): OfferedTeamNote =>
    ({ messageId, offerId: `o-${messageId}`, note: "n", offerStop: false, state: "drafted", surface, anchorMessageId: anchor });
  const msg = (id: string, sender_role: "user" | "assistant", t: number) =>
    ({ id, sender_role, created_at: `2026-10-18T00:00:${String(t).padStart(2, "0")}Z` });

  it("a hard-failure strip anchored on its reply shows until the founder writes again", () => {
    const rows = [msg("u1", "user", 1), msg("r1", "assistant", 2)];
    expect(pickStripNote([n("r1", "strip", "r1")], rows)?.messageId).toBe("r1");
    expect(pickStripNote([n("r1", "strip", "r1")], [...rows, msg("u2", "user", 3)])).toBeNull();
  });

  it("a pushback strip is anchored on the founder's message: it shows through the next reply, until the founder writes again", () => {
    const rows = [msg("u1", "user", 1), msg("r1", "assistant", 2), msg("u2", "user", 3), msg("r2", "assistant", 4)];
    expect(pickStripNote([n("r1", "strip", "u2")], rows)?.messageId).toBe("r1");
    expect(pickStripNote([n("r1", "strip", "u2")], [...rows, msg("u3", "user", 5)])).toBeNull();
  });

  it("two qualify: the newer anchor wins", () => {
    const rows = [msg("u1", "user", 1), msg("r1", "assistant", 2), msg("u2", "user", 3), msg("r2", "assistant", 4)];
    expect(pickStripNote([n("r2", "strip", "r2"), n("r1", "strip", "u2")], rows)?.messageId).toBe("r2");
    expect(pickStripNote([n("r1", "strip", "u2"), n("r2", "strip", "r2")], rows)?.messageId).toBe("r2");
  });

  it("flags, missing anchors and anchors outside the snapshot never strip", () => {
    const rows = [msg("u1", "user", 1), msg("r1", "assistant", 2)];
    expect(pickStripNote([n("r1", "flag", "r1")], rows)).toBeNull();
    expect(pickStripNote([n("r1", "strip", null)], rows)).toBeNull();
    expect(pickStripNote([n("r1", "strip", "gone")], rows)).toBeNull();
    expect(pickStripNote([], rows)).toBeNull();
  });
});

describe("markTeamNoteShown", () => {
  beforeEach(() => apiFetch.mockReset());
  const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b });

  it("strip: posts an empty body (old servers default to strip)", async () => {
    apiFetch.mockResolvedValueOnce(ok({ show: true, offer_stop: true }));
    expect(await markTeamNoteShown("m1", "strip")).toEqual({ show: true, offerStop: true });
    expect(apiFetch.mock.calls[0][0]).toBe("/api/team-notes/m1/shown");
    expect(apiFetch.mock.calls[0][1].body).toBe("{}");
  });

  it("flag: posts via flag", async () => {
    apiFetch.mockResolvedValueOnce(ok({ show: false }));
    expect(await markTeamNoteShown("m1", "flag")).toEqual({ show: false, offerStop: false });
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ via: "flag" });
  });

  it("a non-2xx throws (the caller shows nothing / an error)", async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
    await expect(markTeamNoteShown("m1", "flag")).rejects.toThrow("400");
  });
});
