import { describe, expect, it, vi } from "vitest";
import { isSeatLoginFailure, noteSeatDisabled } from "../seat-disabled-alert";
import { seatLabelForToken } from "../seat-identity";

const DISABLED =
  "Claude Code returned an error result: Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";

function deps(note: string | null = null) {
  const alert = vi.fn(async () => {});
  return {
    alert,
    deps: { alert, readNote: async () => note, now: () => new Date("2026-10-21T14:00:00Z") },
  };
}

describe("noteSeatDisabled", () => {
  it("emails once per seat per UTC hour with the seat and its note", async () => {
    const { alert, deps: d } = deps("ravi max seat");
    await noteSeatDisabled({ token: "tok-a", text: DISABLED, runId: "r1", tenantId: "t1", rotated: false, deps: d });
    expect(alert).toHaveBeenCalledTimes(1);
    const input = (alert.mock.calls[0] as unknown[])[0] as {
      source: string;
      email: { dedupeKey: string; subjectDetail: string; detail: string };
    };
    const seat = seatLabelForToken("tok-a");
    expect(input.source).toBe("claude-seat-disabled");
    expect(input.email.dedupeKey).toBe(`seat_disabled:${seat}:2026-10-21T14`);
    expect(input.email.subjectDetail).toContain("ravi max seat");
    expect(input.email.detail).toContain("did not move to another seat");
    expect(input.email.detail).not.toContain("tok-a");
    expect(input.email.detail).not.toContain("Claude Code returned an error result");
  });

  it("uses a new dedupe key each UTC hour, so a refusal that continues emails again an hour later", async () => {
    const keys: string[] = [];
    for (const iso of ["2026-10-21T14:05:00Z", "2026-10-21T14:55:00Z", "2026-10-21T15:01:00Z"]) {
      const alert = vi.fn(async (input: { email: { dedupeKey: string } }) => {
        keys.push(input.email.dedupeKey);
      });
      await noteSeatDisabled({
        token: "tok-a",
        text: DISABLED,
        runId: "r",
        tenantId: "t",
        rotated: true,
        deps: { alert: alert as never, readNote: async () => null, now: () => new Date(iso) },
      });
    }
    const seat = seatLabelForToken("tok-a");
    expect(keys).toEqual([
      `seat_disabled:${seat}:2026-10-21T14`,
      `seat_disabled:${seat}:2026-10-21T14`,
      `seat_disabled:${seat}:2026-10-21T15`,
    ]);
  });

  it("also fires when the run moved to another seat", async () => {
    const { alert, deps: d } = deps();
    await noteSeatDisabled({
      token: "tok-b",
      text: "Your account does not have access to Claude. Please login again or contact your administrator.",
      runId: "r2",
      tenantId: "t1",
      rotated: true,
      deps: d,
    });
    expect(alert).toHaveBeenCalledTimes(1);
    const input = (alert.mock.calls[0] as unknown[])[0] as { msg: string; email: { detail: string } };
    expect(input.email.detail).toContain("moved to another seat");
    expect(input.msg).toContain("lost access");
    expect(input.email.detail).not.toContain("organization");
  });

  it("stays quiet for usage limits and other errors", async () => {
    const { alert, deps: d } = deps();
    await noteSeatDisabled({ token: "t", text: "You've hit your limit · resets 4pm (UTC)", runId: "r", tenantId: "t", rotated: true, deps: d });
    await noteSeatDisabled({ token: "t", text: "API Error: 500", runId: "r", tenantId: "t", rotated: false, deps: d });
    expect(alert).not.toHaveBeenCalled();
  });

  it("never throws when the alert send fails", async () => {
    const d = { alert: vi.fn(async () => { throw new Error("sendgrid down"); }), readNote: async () => null, now: () => new Date() };
    await expect(
      noteSeatDisabled({ token: "t", text: DISABLED, runId: "r", tenantId: "t", rotated: false, deps: d }),
    ).resolves.toBeUndefined();
  });

});

const EXPIRED_401 =
  'Claude Code returned an error result: API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}';

type AlertInput = { source: string; code: string; msg: string; email: { dedupeKey: string; subjectDetail: string; detail: string } };

describe("noteSeatDisabled on the seat's own login failing (401)", () => {
  it("emails with its own seat_auth_failed key, the seat note, fix steps and only the fixed phrase", async () => {
    const { alert, deps: d } = deps("ravi max seat");
    await noteSeatDisabled({ token: "tok-a", text: EXPIRED_401, runId: "r9", tenantId: "t9", rotated: true, deps: d });
    expect(alert).toHaveBeenCalledTimes(1);
    const input = (alert.mock.calls[0] as unknown[])[0] as AlertInput;
    const seat = seatLabelForToken("tok-a");
    expect(input.source).toBe("claude-seat-auth-failed");
    expect(input.code).toBe("seat_auth_failed");
    expect(input.email.dedupeKey).toBe(`seat_auth_failed:${seat}:2026-10-21T14`);
    expect(input.email.subjectDetail).toContain("ravi max seat");
    expect(input.email.detail).toContain("Run: r9 (tenant t9)");
    expect(input.email.detail).toContain("moved to another seat");
    expect(input.email.detail).toContain("OAuth token has expired (API Error: 401).");
    expect(input.email.detail).toContain("Log this seat back in (claude login / refresh the token in the seat pool)");
    expect(input.email.detail).not.toContain("Please obtain a new token");
    expect(input.email.detail).not.toContain("Claude Code returned an error result");
    expect(input.email.detail).not.toContain("tok-a");
    expect(`${input.msg}${input.email.detail}${input.email.subjectDetail}`).not.toContain("\u2014");
  });

  it("matches a bare CLI 401 throw and a revoked token", async () => {
    const { alert, deps: d } = deps();
    await noteSeatDisabled({
      token: "tok-c",
      text: "Failed to authenticate. API Error: 401 OAuth access token has been revoked",
      runId: "r",
      tenantId: "t",
      rotated: false,
      deps: d,
    });
    const input = (alert.mock.calls[0] as unknown[])[0] as AlertInput;
    expect(input.email.dedupeKey.startsWith("seat_auth_failed:")).toBe(true);
    expect(input.email.detail).toContain("OAuth token has been revoked (API Error: 401).");
    expect(input.email.detail).toContain("did not move to another seat");
  });

  it("keeps the org-disabled refusal on the old seat_disabled key", async () => {
    const { alert, deps: d } = deps();
    await noteSeatDisabled({ token: "tok-a", text: DISABLED, runId: "r", tenantId: "t", rotated: false, deps: d });
    const input = (alert.mock.calls[0] as unknown[])[0] as AlertInput;
    expect(input.email.dedupeKey.startsWith("seat_disabled:")).toBe(true);
    expect(input.code).toBe("seat_disabled");
  });

  it("never emails on a customer connector's OAuth error", async () => {
    const { alert, deps: d } = deps();
    const connectorErrors = [
      "Meta Ads: Error validating access token: OAuth access token has expired",
      "Google sign-in broke: OAuth token has expired",
      'Google Ads request failed: {"error":{"code":401,"status":"UNAUTHENTICATED"}} authentication_error',
      "Browser check: fetch /api/me failed with API Error: 401",
      "The app's AI chat calls Anthropic: API Error: 401 authentication_error invalid x-api-key",
    ];
    for (const text of connectorErrors) {
      expect(isSeatLoginFailure(text)).toBe(false);
      await noteSeatDisabled({ token: "t", text, runId: "r", tenantId: "t", rotated: false, deps: d });
    }
    expect(alert).not.toHaveBeenCalled();
  });

  it("sends one email per seat per UTC hour (same key for repeats inside the hour)", async () => {
    const keys: string[] = [];
    for (const iso of ["2026-10-21T14:05:00Z", "2026-10-21T14:40:00Z", "2026-10-21T15:02:00Z"]) {
      const alert = vi.fn(async (input: { email: { dedupeKey: string } }) => {
        keys.push(input.email.dedupeKey);
      });
      await noteSeatDisabled({
        token: "tok-a",
        text: EXPIRED_401,
        runId: "r",
        tenantId: "t",
        rotated: true,
        deps: { alert: alert as never, readNote: async () => null, now: () => new Date(iso) },
      });
    }
    const seat = seatLabelForToken("tok-a");
    expect(keys).toEqual([
      `seat_auth_failed:${seat}:2026-10-21T14`,
      `seat_auth_failed:${seat}:2026-10-21T14`,
      `seat_auth_failed:${seat}:2026-10-21T15`,
    ]);
  });
});
