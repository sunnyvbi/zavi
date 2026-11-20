// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

import { DISPLAY_CHANNELS } from "@/lib/workspace/feedRows";
import { DecisionCard, type Decision } from "../ChannelsPanel";

afterEach(cleanup);

const channel = DISPLAY_CHANNELS[0]!;

const row = (over: Partial<Decision> = {}): Decision => ({
  id: "ca-1",
  decision_class: "channel.recipe_step",
  body: { step: { title: "Add the conversion tag", body: "Why it matters.", blocking: false, evidence: ["x"] } },
  handler: null,
  emitted_at: new Date().toISOString(),
  channel_slug: channel.slug,
  action_source: "channel_action",
  exec_class: null,
  ...over,
});

function mount(d: Decision) {
  const handlers = {
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onReview: vi.fn(),
    onOpen: vi.fn(),
    onOpenChannel: vi.fn(),
  };
  render(
    <ul>
      <DecisionCard decision={d} channel={channel} mode="execute" busy={false} {...handlers} />
    </ul>,
  );
  return handlers;
}

describe("a channel card that changes nothing on approve", () => {
  it("shows the card's own button words and opens the channel, with no decide call", () => {
    const h = mount(row({ card_kind: "task", primary_label: "Open settings", done_label: "I did it" }));
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(h.onOpenChannel).toHaveBeenCalledTimes(1);
    expect(h.onApprove).not.toHaveBeenCalled();
    expect(h.onReject).not.toHaveBeenCalled();
  });

  it("reads Open when the row predates stored words", () => {
    const h = mount(row({ primary_label: null }));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(h.onOpenChannel).toHaveBeenCalledTimes(1);
  });
});

describe("an executable ad change", () => {
  it("keeps Approve, named after the change the server wrote", () => {
    const h = mount(
      row({ exec_class: "linkedin_organic.publish_post", body: { action_label: "Publish", step: { title: "Publish the launch post" } } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(h.onApprove).toHaveBeenCalledTimes(1);
    expect(h.onOpenChannel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("still sends a high-stakes change to Review, never approving it from the row", () => {
    const h = mount(row({ exec_class: "meta_ads.pause_adset", body: { action_label: "Pause" } }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(h.onReview).toHaveBeenCalledTimes(1);
    expect(h.onApprove).not.toHaveBeenCalled();
  });

  it("falls back to Approve when the row carries no change label", () => {
    const h = mount(row({ exec_class: "linkedin_organic.publish_post" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(h.onApprove).toHaveBeenCalledTimes(1);
  });
});

describe("a decisions row", () => {
  it("is unchanged: Approve and Reject where Zavi can act", () => {
    mount(row({ action_source: "decision", primary_label: "Open settings" }));
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open settings" })).toBeNull();
  });
});

describe("the Blocking pill", () => {
  it("shows on a blocking row, with the reason on hover", () => {
    mount(row({ body: { step: { title: "Add the conversion tag", blocking: true, evidence: ["x"] } } }));
    expect(screen.getByText("Blocking").getAttribute("title")).toBe("Other cards on this channel wait on this");
  });

  it("is absent on a row that does not block", () => {
    mount(row());
    expect(screen.queryByText("Blocking")).toBeNull();
  });
});
