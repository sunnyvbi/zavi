// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelActionFrame } from "./ChannelActionFrame";

const card = (body: Record<string, unknown>) =>
  ({
    id: "a-1",
    channel_slug: "generated_video",
    action_type: "video_post",
    card_kind: "action",
    source: "channel_action",
    title: "Hook: Rent a car in two taps",
    status: "proposed",
    body: { step: { title: "t", body: "It costs about 860 credits, charged only when the video arrives.", deliverable: { kind: "script", label: "The script", content: "x" } }, exact_change: { rows: [] }, ...body },
  }) as never;

afterEach(cleanup);

describe("a video card's details row", () => {
  it("shows the same credit price as the card's own line instead of Not supplied", () => {
    render(<ChannelActionFrame a={card({ cost_credits: 860 })} header={null} right={null} />);
    const cost = screen.getByTestId("action-cost").textContent ?? "";
    expect(cost).toBe("860 credits, charged only when the video arrives");
    expect(cost).not.toContain("Not supplied");
  });

  it("still says Not supplied when a card carries no price at all", () => {
    render(<ChannelActionFrame a={card({})} header={null} right={null} />);
    expect(screen.getByTestId("action-cost").textContent).toBe("Not supplied");
  });
});

describe("a Pinterest setup step's details row", () => {
  it("has no cost row at all, never Not supplied", () => {
    const pin = { ...(card({}) as Record<string, unknown>), channel_slug: "pinterest_organic", title: "Create a Pinterest board for car rentals" } as never;
    render(<ChannelActionFrame a={pin} header={null} right={null} />);
    expect(screen.queryByTestId("action-cost")).toBeNull();
    expect(document.body.textContent).not.toContain("Not supplied");
  });
});
