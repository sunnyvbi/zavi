// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("./EmailCampaignCard", () => ({
  EmailCampaignCard: ({ rail, id, onAskZavi, onChanged }: { rail: string; id: string; onAskZavi?: () => void; onChanged?: () => void }) => (
    <div data-testid="email-card" data-rail={rail} data-id={id}>
      {onAskZavi && (
        <button type="button" onClick={onAskZavi}>
          Ask Zavi to change it
        </button>
      )}
      {onChanged && (
        <button type="button" onClick={onChanged}>
          card changed
        </button>
      )}
    </div>
  ),
}));

import { ApprovalBlock } from "@/components/agents/ApprovalBlock";
import { ChannelActionCard } from "@/components/workspace/actions/ChannelActionCard";
import { platformFor } from "@/components/workspace/actions/platforms";
import { makeAction } from "@/components/workspace/actions/__tests__/fixtures";

afterEach(cleanup);

describe("email card hosts", () => {
  for (const cls of ["email_campaign.create_and_send", "bulk_outbound.send"]) {
    it(`ApprovalBlock renders ${cls} as the email card on the decisions rail`, () => {
      render(<ApprovalBlock body={{ decision_id: "d-1", decision_class: cls, title: "Email to send" }} />);
      const c = screen.getByTestId("email-card");
      expect([c.dataset.rail, c.dataset.id]).toEqual(["decisions", "d-1"]);
      expect(screen.queryByRole("button", { name: /Approve|Confirm/ })).toBeNull();
    });
  }

  it("ChannelActionCard renders an open email send as the email card, and an approved one as its usual body", () => {
    const handlers = { onSetStatus: vi.fn(), onRedo: vi.fn() };
    const open = makeAction("send_message", { channel_slug: "email_marketing", executable: true, email_card: true, exec_status: null });
    render(<ChannelActionCard action={open} platform={platformFor("email_marketing")} handlers={handlers} />);
    expect(screen.getByTestId("email-card").dataset.rail).toBe("channel_actions");
    cleanup();
    const queued = makeAction("send_message", { channel_slug: "email_marketing", executable: true, email_card: true, exec_status: "queued" });
    render(<ChannelActionCard action={queued} platform={platformFor("email_marketing")} handlers={handlers} />);
    expect(screen.queryByTestId("email-card")).toBeNull();
  });

  it("Ask Zavi to change it opens the channel chat on THIS card; with no chat there is no button", () => {
    const onOpenChat = vi.fn();
    const open = makeAction("send_message", { channel_slug: "email_marketing", executable: true, email_card: true, exec_status: null });
    render(<ChannelActionCard action={open} platform={platformFor("email_marketing")} handlers={{ onSetStatus: vi.fn(), onRedo: vi.fn(), onOpenChat }} />);
    screen.getByRole("button", { name: "Ask Zavi to change it" }).click();
    expect(onOpenChat).toHaveBeenCalledWith(open);
    cleanup();
    render(<ChannelActionCard action={open} platform={platformFor("email_marketing")} handlers={{ onSetStatus: vi.fn(), onRedo: vi.fn() }} />);
    expect(screen.queryByRole("button", { name: "Ask Zavi to change it" })).toBeNull();
    cleanup();
    render(<ApprovalBlock body={{ decision_id: "d-1", decision_class: "bulk_outbound.send", title: "Email to send" }} />);
    expect(screen.queryByRole("button", { name: "Ask Zavi to change it" })).toBeNull();
  });

  it("a change on the email card (approve, test, edit, schedule, stop) refreshes the channel's list", () => {
    const onEmailCardChanged = vi.fn();
    const open = makeAction("send_message", { channel_slug: "email_marketing", executable: true, email_card: true, exec_status: null });
    render(<ChannelActionCard action={open} platform={platformFor("email_marketing")} handlers={{ onSetStatus: vi.fn(), onRedo: vi.fn(), onEmailCardChanged }} />);
    screen.getByRole("button", { name: "card changed" }).click();
    expect(onEmailCardChanged).toHaveBeenCalledWith(open);
  });
});
