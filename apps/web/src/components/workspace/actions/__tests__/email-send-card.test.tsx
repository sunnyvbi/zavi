// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "@/components/ui/toast";
import { resetExecFailureToasts } from "../ActionFooter";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { FIXTURES, makeAction } from "./fixtures";

afterEach(cleanup);

const email = platformFor("email_marketing");
const handlers = (over: Partial<ActionHandlers> = {}) =>
  ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn(), ...over }) satisfies ActionHandlers;

const sendCard = (over: Parameters<typeof makeAction>[1] = {}) =>
  makeAction("send_message", {
    channel_slug: "email_marketing",
    title: 'Send "Autumn offer" to Newsletter',
    executable: true,
    card_kind: "executes",
    primary_label: "Send to 412 people",
    done_label: "Done",
    how_to: [],
    body: {
      step: {
        title: 'Send "Autumn offer" to Newsletter',
        body: 'Zavi creates this email in Mailchimp and sends it to your "Newsletter" list, 412 people today.',
        blocking: false,
        effort: "minutes",
        evidence: [],
        deliverable: { kind: "email", label: "Autumn offer", content: "Hello, the autumn offer is open for two weeks." },
      },
      exact_change: {
        rows: [
          { item: "Subject", before: "", after: "Autumn offer" },
          { item: "Sending with", before: "", after: "Mailchimp" },
          { item: "List", before: "", after: "Newsletter" },
          { item: "People", before: "", after: "412" },
        ],
      },
    },
    ...over,
  });

describe("the email send card", () => {
  it("shows the subject, the tool, the list, the people and the email before the button", () => {
    render(<ChannelActionCard action={sendCard()} platform={email} handlers={handlers()} />);
    const change = screen.getByTestId("exact-change").textContent ?? "";
    for (const text of ["Subject", "Autumn offer", "Sending with", "Mailchimp", "List", "Newsletter", "People", "412"]) expect(change).toContain(text);
    expect(document.body.textContent).toContain("Hello, the autumn offer is open for two weeks.");
  });

  it("the button says how many people it goes to, and pressing it approves", () => {
    const h = handlers();
    const a = sendCard();
    render(<ChannelActionCard action={a} platform={email} handlers={h} />);
    fireEvent.click(screen.getByRole("button", { name: "Send to 412 people" }));
    expect(h.onApprove).toHaveBeenCalledWith(a);
  });

  it("while it runs it says it is sending, and offers nothing to press", () => {
    render(<ChannelActionCard action={sendCard({ exec_status: "dispatching" })} platform={email} handlers={handlers()} />);
    expect(screen.getByTestId("exec-state").textContent).toContain("Zavi is sending your email");
    expect(screen.queryByRole("button", { name: /Send to/ })).toBeNull();
  });

  it('once sent it ends "Sent to N people via <tool>" with a link to it', () => {
    const a = sendCard({ exec_status: "executed", status: "acted", exec_receipt: { line: "Sent to 412 people via Mailchimp", url: "https://admin.mailchimp.com/campaigns/show/?id=9000" } });
    render(<ChannelActionCard action={a} platform={email} handlers={handlers()} />);
    const state = screen.getByTestId("exec-state");
    expect(state.getAttribute("data-exec")).toBe("executed");
    expect(screen.getByTestId("exec-receipt").textContent).toBe("Sent to 412 people via Mailchimp");
    const link = screen.getByTestId("exec-receipt-link");
    expect(link.getAttribute("href")).toBe("https://admin.mailchimp.com/campaigns/show/?id=9000");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.queryByRole("button", { name: /Send to/ })).toBeNull();
  });

  it("a receipt with no link shows the line alone", () => {
    const a = sendCard({ exec_status: "executed", status: "acted", exec_receipt: { line: "Sent to 1 person via Klaviyo" } });
    render(<ChannelActionCard action={a} platform={email} handlers={handlers()} />);
    expect(screen.getByTestId("exec-receipt").textContent).toBe("Sent to 1 person via Klaviyo");
    expect(screen.queryByTestId("exec-receipt-link")).toBeNull();
  });

  it("the tool was disconnected: nothing sent, the reason in plain words, and what to do", () => {
    const a = sendCard({
      exec_status: "failed",
      exec_code: "email_tool_not_connected",
      exec_bucket: "needs_founder",
      exec_fix_text: "reconnect Mailchimp or Klaviyo in Settings",
      note: "Mailchimp is not connected, or a different Mailchimp account is connected now. Nothing was sent. Reconnect Mailchimp, then approve again.",
    });
    resetExecFailureToasts();
    const add = vi.spyOn(toast, "add").mockImplementation(() => "t");
    render(<ChannelActionCard action={a} platform={email} handlers={handlers()} />);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]).toMatchObject({ title: "This email was not sent", description: "Mailchimp is not connected, or a different Mailchimp account is connected now." });
    add.mockRestore();
    expect(screen.getByTestId("exec-fix").textContent).toBe("This needs you: reconnect Mailchimp or Klaviyo in Settings.");
    expect(screen.getByTestId("exec-reason").textContent).toContain("Reconnect Mailchimp, then approve again.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("no second reason line when the fix-it line already says it", () => {
    const a = sendCard({
      exec_status: "failed",
      exec_code: "email_tool_not_connected",
      exec_bucket: "needs_founder",
      exec_fix_text: "reconnect Mailchimp",
      note: "Reconnect Mailchimp",
    });
    render(<ChannelActionCard action={a} platform={email} handlers={handlers()} />);
    expect(screen.getByTestId("exec-fix")).toBeTruthy();
    expect(screen.queryByTestId("exec-reason")).toBeNull();
  });

  it("a temporary failure with no fix-it line still keeps its reason on the card", () => {
    const a = sendCard({ exec_status: "failed", exec_code: "rate_limited", exec_bucket: "temporary", note: "Mailchimp was busy. Nothing was sent." });
    render(<ChannelActionCard action={a} platform={email} handlers={handlers()} />);
    expect(screen.getByTestId("exec-reason").textContent).toBe("Mailchimp was busy. Nothing was sent.");
  });

  it("an unknown outcome is never offered again", () => {
    const a = sendCard({ exec_status: "failed", exec_code: "exec_outcome_unknown", exec_bucket: "partial_risk", note: "Mailchimp did not confirm whether this email was sent." });
    render(<ChannelActionCard action={a} platform={email} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send to/ })).toBeNull();
  });
});

describe("executed cards on other channels", () => {
  const gads = platformFor("google_ads");

  it("with no receipt, keep their fixed line", () => {
    const a = makeAction("pause_ad", { ...FIXTURES.pause_ad, id: "done-plain", exec_status: "executed" });
    render(<ChannelActionCard action={a} platform={gads} handlers={handlers()} />);
    expect(screen.getByTestId("exec-state").textContent).toBe("Paused in Google Ads");
    expect(screen.queryByTestId("exec-receipt")).toBeNull();
  });

  it("a null receipt is the same as none", () => {
    const a = makeAction("pause_ad", { ...FIXTURES.pause_ad, id: "done-null", exec_status: "executed", exec_receipt: null });
    render(<ChannelActionCard action={a} platform={gads} handlers={handlers()} />);
    expect(screen.getByTestId("exec-state").textContent).toBe("Paused in Google Ads");
  });
});
