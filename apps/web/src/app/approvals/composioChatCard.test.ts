import { describe, it, expect } from "vitest";
import {
  composioChatCardState,
  OWNER_OR_ADMIN_APPROVE_REASON,
  VIEWER_APPROVE_REASON,
} from "./composioChatCard";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const body = { app_name: "Square", labels: ["moves_money"] };

describe("composioChatCardState", () => {
  it("a viewer can approve nothing, not even a plain write", () => {
    const plain = { decision_class: "composio.write", status: "proposed", body: { app_name: "Square", labels: [] } };
    expect(composioChatCardState(plain, "viewer", NOW).approveBlockedReason).toBe(VIEWER_APPROVE_REASON);
    const money = { decision_class: "composio.moves_money", status: "proposed", body };
    expect(composioChatCardState(money, "viewer", NOW).approveBlockedReason).toBe(VIEWER_APPROVE_REASON);
  });

  it("pending money write: owners and admins can approve, members cannot", () => {
    const d = { decision_class: "composio.moves_money", status: "proposed", body };
    expect(composioChatCardState(d, "member", NOW)).toEqual({ phase: "pending", appName: "Square", approveBlockedReason: OWNER_OR_ADMIN_APPROVE_REASON });
    expect(composioChatCardState(d, "owner", NOW).approveBlockedReason).toBeNull();
    expect(composioChatCardState(d, "admin", NOW).approveBlockedReason).toBeNull();
    expect(composioChatCardState(d, null, NOW).approveBlockedReason).toBeNull();
  });
  it("a delete label gates a member too; a plain write does not", () => {
    expect(composioChatCardState({ decision_class: "composio.write", status: "proposed", body: { labels: ["deletes_data"] } }, "member", NOW).approveBlockedReason).toBe(OWNER_OR_ADMIN_APPROVE_REASON);
    expect(composioChatCardState({ decision_class: "composio.write", status: "proposed", body: { labels: [] } }, "member", NOW).approveBlockedReason).toBeNull();
  });
  it("a crashed write (dispatching > 10 min) is Outcome unknown; a fresh one is running", () => {
    const base = { decision_class: "composio.write", status: "dispatching", body };
    expect(composioChatCardState({ ...base, dispatched_at: "2026-09-25T11:40:00Z" }, "owner", NOW).phase).toBe("outcome_unknown");
    expect(composioChatCardState({ ...base, dispatched_at: "2026-09-25T11:58:00Z" }, "owner", NOW).phase).toBe("running");
  });
  it("maps the terminal statuses", () => {
    const s = (status: string) => composioChatCardState({ decision_class: "composio.write", status, body: null }, "owner", NOW);
    expect(s("approved").phase).toBe("running");
    expect(s("acted").phase).toBe("done");
    expect(s("rejected").phase).toBe("rejected");
    expect(s("dispatch_failed").phase).toBe("failed");
    expect(s("expired").phase).toBe("closed");
    expect(s("acted").appName).toBe("the app");
  });

  describe("a one-to-one email whose send was not confirmed", () => {
    const GMAIL = "Gmail did not confirm the send, so it may or may not have gone out. Check your Gmail Sent folder before sending it again.";
    const SENDGRID = "SendGrid did not confirm the send, so it may or may not have gone out. Check SendGrid's activity feed before sending it again.";
    const row = (dispatch_error: string | null, decision_class = "outbound.send") => ({ decision_class, status: "dispatch_failed", body: { channel: "email" }, dispatch_error });

    it.each([["Gmail", GMAIL], ["SendGrid", SENDGRID]])("%s: the card says check your email, never that it did not go through", (_label, err) => {
      expect(composioChatCardState(row(err), "owner", NOW)).toMatchObject({ phase: "outcome_unknown", appName: "your email" });
    });

    it("a definite failure of the same email still reads as failed", () => {
      expect(composioChatCardState(row("Gmail did not send it: Invalid To header"), "owner", NOW).phase).toBe("failed");
      expect(composioChatCardState(row(null), "owner", NOW).phase).toBe("failed");
    });

    it("another kind of card with the same words is not changed", () => {
      expect(composioChatCardState(row(GMAIL, "composio.write"), "owner", NOW).phase).toBe("failed");
    });
  });
});
