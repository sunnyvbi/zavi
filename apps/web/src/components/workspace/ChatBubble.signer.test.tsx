// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatBubble } from "./ChatBubble";

afterEach(cleanup);

describe("ChatBubble signer", () => {
  it("signs a cgo handoff as Your CGO with a link to the Growth page", () => {
    render(<ChatBubble role="assistant" text="Your constraint is supply." agentSlug="cgo" fromAgentSlug="cgo" />);
    expect(screen.getByText("Your CGO")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open Growth page" });
    expect(link.getAttribute("href")).toBe("/workspace?tab=growth-strategy");
  });

  it("signs a channel handoff with the channel's registry name", () => {
    render(<ChatBubble role="assistant" text="Paused." agentSlug="meta_ads" fromAgentSlug="meta_ads" />);
    expect(screen.getByText("Meta Ads")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open Growth page" })).toBeNull();
  });

  it("draws no signer on an ordinary reply, even when agentSlug is a specialist", () => {
    render(<ChatBubble role="assistant" text="Hello." agentSlug="cgo" />);
    expect(screen.queryByText("Your CGO")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open Growth page" })).toBeNull();
  });

  it("does not sign twice when the body also carries the old handoff header", () => {
    render(
      <ChatBubble
        role="assistant"
        text={"@meta_ads → handed off from @operator\n\nPaused."}
        agentSlug="meta_ads"
        fromAgentSlug="meta_ads"
      />,
    );
    expect(screen.getAllByText("Meta Ads")).toHaveLength(1);
    expect(screen.queryByText(/handed off/)).toBeNull();
  });
});
