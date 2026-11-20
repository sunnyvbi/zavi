import { describe, it, expect, vi, beforeEach } from "vitest";

const { state, requireAuthMock } = vi.hoisted(() => {
  const s = { auth: { user_id: "u-1", tenant_id: "11111111-1111-1111-1111-111111111111" } as Record<string, unknown> | null };
  return { state: s, requireAuthMock: vi.fn(async () => s.auth) };
});
vi.mock("@/services/auth/middleware", () => ({ requireAuth: requireAuthMock }));
const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: trackMock }));

const { store } = vi.hoisted(() => {
  class TeamNoteError extends Error { constructor(public code: string, m: string) { super(m); } }
  return {
    store: {
      TeamNoteError,
      markShown: vi.fn(async () => ({ show: true, offer_stop: false, first: true, signal: "tool_failure", source: "run_end" })),
      sendNote: vi.fn(async () => ({ status: "sent", report_id: "r1", first: true, signal: "tool_failure", source: "run_end" })),
      dismissNote: vi.fn(async () => ({ status: "dismissed", signal: "tool_failure", source: "run_end" })),
      markOpened: vi.fn(async () => ({ status: "opened", signal: "tool_failure", source: "run_end" })),
      getSuggestionsOff: vi.fn(async () => false),
      setSuggestionsOff: vi.fn(async () => {}),
    },
  };
});
vi.mock("@/services/team-notes/store", () => store);
const { enabledMock } = vi.hoisted(() => ({ enabledMock: vi.fn(async () => true) }));
vi.mock("@/services/settings", () => ({ getBoolSetting: enabledMock }));
const { sendEvent, logMock } = vi.hoisted(() => ({
  sendEvent: vi.fn(async (_e: Record<string, unknown>) => ({})),
  logMock: vi.fn(async (_e: Record<string, unknown>) => {}),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: sendEvent } }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: logMock }));
vi.mock("@/services/tenant-client", () => ({ opsRpc: vi.fn() }));

import { teamNoteShown, teamNoteSend, teamNoteDismiss, teamNoteOpened, teamNotePrefsPut } from "../index";

const T = "11111111-1111-1111-1111-111111111111";
const MSG = "44444444-4444-4444-4444-444444444444";
function res() {
  return { statusCode: 200, body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    end() { return this; } };
}
const req = (body: unknown, id = MSG) => ({ params: { messageId: id }, body }) as never;

beforeEach(() => { vi.clearAllMocks(); enabledMock.mockResolvedValue(true); state.auth = { user_id: "u-1", tenant_id: T }; });

describe("team-notes routes", () => {
  it("send passes the SESSION tenant and user; unknown body keys are rejected", async () => {
    const r = res();
    await teamNoteSend(req({ note: "It failed.", tenant_id: "evil" }), r as never);
    expect(r.statusCode).toBe(400);
    await teamNoteSend(req({ note: "It failed." }), r as never);
    expect(store.sendNote).toHaveBeenCalledWith(T, "u-1", MSG, "It failed.", null);
  });

  it("send failure is non-2xx (UI says 'Not sent, try again')", async () => {
    store.sendNote.mockRejectedValueOnce(new store.TeamNoteError("failed", "x"));
    const r = res();
    await teamNoteSend(req({ note: "It failed." }), r as never);
    expect(r.statusCode).toBe(500);
    expect(trackMock).not.toHaveBeenCalled();
  });

  it("someone else's chat is a 403", async () => {
    store.sendNote.mockRejectedValueOnce(new store.TeamNoteError("forbidden", "Not your chat."));
    const r = res();
    await teamNoteSend(req({ note: "x" }), r as never);
    expect(r.statusCode).toBe(403);
  });

  it("not_offered / closed are 409, never reported as sent", async () => {
    store.sendNote.mockResolvedValueOnce({ status: "closed" } as never);
    const r = res();
    await teamNoteSend(req({ note: "x" }), r as never);
    expect(r.statusCode).toBe(409);
  });

  it("a non-uuid message id is a 404 and calls nothing", async () => {
    const r = res();
    await teamNoteSend(req({ note: "x" }, "abc"), r as never);
    expect(r.statusCode).toBe(404);
    expect(store.sendNote).not.toHaveBeenCalled();
  });

  it("unauthenticated: nothing is called", async () => {
    state.auth = null;
    await teamNoteDismiss(req({}), res() as never);
    expect(store.dismissNote).not.toHaveBeenCalled();
  });

  it("a viewer who owns the thread can send (the RPC checks ownership)", async () => {
    state.auth = { user_id: "viewer-1", tenant_id: T, role: "viewer" };
    const r = res();
    await teamNoteSend(req({ note: "x" }), r as never);
    expect(r.statusCode).toBe(200);
    expect(store.sendNote).toHaveBeenCalledWith(T, "viewer-1", MSG, "x", null);
  });

  it("tracks events with IDs and codes only, never text", async () => {
    await teamNoteShown(req({}), res() as never);
    await teamNoteSend(req({ note: "secret words" }), res() as never);
    await teamNoteOpened(req(undefined), res() as never);
    await teamNoteDismiss(req({ stop: true }), res() as never);
    const names = trackMock.mock.calls.map((c) => c[0]);
    expect(names).toEqual(["team_note_shown", "team_note_sent", "team_note_see_note_opened", "team_note_stop_suggesting"]);
    for (const [name, props] of trackMock.mock.calls) {
      expect(props).toEqual({
        tenant_id: T, user_id: "u-1", message_id: MSG, signal: "tool_failure", source: "run_end",
        ...(name === "team_note_shown" ? { via: "strip" } : {}),
      });
    }
  });

  it("a repeat send (first=false) is not tracked twice", async () => {
    store.sendNote.mockResolvedValueOnce({ status: "sent", report_id: "r1", first: false, signal: "s", source: "run_end" });
    await teamNoteSend(req({ note: "x" }), res() as never);
    expect(trackMock).not.toHaveBeenCalled();
  });

  it("R10: draft exists, feature then turned off -> /shown refuses without touching the RPC", async () => {
    enabledMock.mockResolvedValueOnce(false);
    const r = res();
    await teamNoteShown(req({}), r as never);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ show: false, offer_stop: false });
    expect(store.markShown).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it("prefs put writes the caller's own switch", async () => {
    await teamNotePrefsPut({ body: { suggestions_off: false } } as never, res() as never);
    expect(store.setSuggestionsOff).toHaveBeenCalledWith(T, "u-1", false);
  });

  it("/shown: no body (an old tab) means the strip", async () => {
    const r = res();
    await teamNoteShown(req({}), r as never);
    expect(store.markShown).toHaveBeenCalledWith(T, "u-1", MSG, "strip");
    expect(r.body).toEqual({ show: true, offer_stop: false });
  });

  it("/shown {via:'flag'}: the flag path, tracked as such", async () => {
    await teamNoteShown(req({ via: "flag" }), res() as never);
    expect(store.markShown).toHaveBeenCalledWith(T, "u-1", MSG, "flag");
    expect(trackMock).toHaveBeenCalledWith("team_note_shown", expect.objectContaining({ via: "flag" }));
  });

  it.each([[{ via: "banner" }], [{ via: "flag", extra: 1 }], [{ via: null }]])("/shown rejects a bad body %j", async (body) => {
    const r = res();
    await teamNoteShown(req(body), r as never);
    expect(r.statusCode).toBe(400);
    expect(store.markShown).not.toHaveBeenCalled();
  });

  it("/shown refused by the RPC (a flag-only note asked for as a strip) is show:false, not tracked", async () => {
    store.markShown.mockResolvedValueOnce({ show: false, reason: "flag_only" } as never);
    const r = res();
    await teamNoteShown(req({}), r as never);
    expect(r.body).toEqual({ show: false, offer_stop: false });
    expect(trackMock).not.toHaveBeenCalled();
  });

  it("a first send asks the ping drainer for this window: one event id per ping row", async () => {
    store.sendNote.mockResolvedValueOnce({ status: "sent", report_id: "r1", first: true, signal: "s", source: "run_end", ping_id: 77 } as never);
    const r = res();
    await teamNoteSend(req({ note: "x" }), r as never);
    expect(r.statusCode).toBe(200);
    await new Promise((x) => setTimeout(x, 0));
    expect(sendEvent).toHaveBeenCalledWith({ name: "team_report_ping.due", id: "team-report-ping-77", data: { ping_id: 77 } });
  });

  it("a repeat send (first=false) emits no ping event", async () => {
    store.sendNote.mockResolvedValueOnce({ status: "sent", report_id: "r1", first: false, signal: "s", source: "run_end", ping_id: 77 } as never);
    await teamNoteSend(req({ note: "x" }), res() as never);
    await new Promise((x) => setTimeout(x, 0));
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["rejects", () => sendEvent.mockRejectedValueOnce(new Error("inngest down"))],
    ["throws", () => sendEvent.mockImplementationOnce(() => { throw new Error("sync boom"); })],
  ])("an event send that %s never fails the founder's send; it is logged as a warn", async (_l, fail) => {
    fail();
    store.sendNote.mockResolvedValueOnce({ status: "sent", report_id: "r1", first: true, signal: "s", source: "run_end", ping_id: 5 } as never);
    const r = res();
    await teamNoteSend(req({ note: "x" }), r as never);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ status: "sent", report_id: "r1" });
    await new Promise((x) => setTimeout(x, 0));
    expect(logMock).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", code: "team_report_ping.event_send_failed" }));
  });

  it("no ping id (an old database) emits nothing", async () => {
    store.sendNote.mockResolvedValueOnce({ status: "sent", report_id: "r1", first: true, signal: "s", source: "run_end" } as never);
    await teamNoteSend(req({ note: "x" }), res() as never);
    await new Promise((x) => setTimeout(x, 0));
    expect(sendEvent).not.toHaveBeenCalled();
  });
});
