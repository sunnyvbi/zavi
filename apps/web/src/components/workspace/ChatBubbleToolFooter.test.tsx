import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatBubble } from "./ChatBubble";

describe("ChatBubble — tool-list footer is NOT rendered on the customer chat surface (G-S4)", () => {
  const leakyTools = [
    "ToolSearch",
    "mcp__server__meta_ads__list_campaigns",
    "mcp__server__meta_ads__list_ad_sets",
    "mcp__server__meta_ads__propose_budget_change",
  ];

  it("does not render a 'Used …' footer even when tools are passed", () => {
    const html = renderToStaticMarkup(
      <ChatBubble
        role="assistant"
        text="Doubling Gig Rentals to $144/day now."
        agentSlug="performance-marketer"
        tools={leakyTools}
      />,
    );
    expect(html).not.toContain("Used ");
  });

  it("does not leak any raw mcp__server__* tool name into the markup", () => {
    const html = renderToStaticMarkup(
      <ChatBubble
        role="assistant"
        text="Set ad set to $144/day."
        agentSlug="performance-marketer"
        tools={leakyTools}
      />,
    );
    expect(html).not.toContain("mcp__server__");
    expect(html).not.toContain("meta_ads__list_campaigns");
    expect(html).not.toContain("propose_budget_change");
  });

  it("still renders the assistant prose body (we only removed the footer, not the message)", () => {
    const html = renderToStaticMarkup(
      <ChatBubble
        role="assistant"
        text="Doubling Gig Rentals now."
        agentSlug="performance-marketer"
        tools={leakyTools}
      />,
    );
    expect(html).toContain("Doubling Gig Rentals now.");
  });
});
