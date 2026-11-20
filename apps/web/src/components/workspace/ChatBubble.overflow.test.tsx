import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatBubble } from "./ChatBubble";

const LEAD = "Found it. This is real evidence, not a guess.";
const FULL =
  "Found it. This is real evidence, not a guess. The compiled dist bundle still " +
  "contains the old code path, and there is no Dockerfile at the repo root.";

describe("ChatBubble — collapsed-reply overflow shows the whole answer", () => {
  it("renders the full body in place, with no expander", () => {
    const html = renderToStaticMarkup(
      <ChatBubble role="assistant" text={LEAD} fullReplyMarkdown={FULL} agentSlug="engineer" />,
    );
    expect(html).not.toContain("<details");
    expect(html).not.toContain("Show full reply");
    expect(html.indexOf("Found it.")).toBeLessThan(html.indexOf("no Dockerfile"));
    expect(html).toContain("no Dockerfile at the repo root");
  });

  it("renders NO expander when there is no overflow (normal reply is untouched)", () => {
    const html = renderToStaticMarkup(
      <ChatBubble role="assistant" text={LEAD} agentSlug="engineer" />,
    );
    expect(html).not.toContain("Show full reply");
    expect(html).not.toContain("<details");
  });

  it("renders NO expander when the overflow merely duplicates the visible text", () => {
    const html = renderToStaticMarkup(
      <ChatBubble role="assistant" text={FULL} fullReplyMarkdown={FULL} agentSlug="engineer" />,
    );
    expect(html).not.toContain("Show full reply");
  });

  it("renders NO expander while the reply is still streaming", () => {
    const html = renderToStaticMarkup(
      <ChatBubble
        role="assistant"
        text={LEAD}
        fullReplyMarkdown={FULL}
        agentSlug="engineer"
        isStreaming
      />,
    );
    expect(html).not.toContain("<details");
  });
});

describe("ChatBubble — a long reply is never clamped", () => {
  it("renders every line of a long reply with no 'Show full reply' control", () => {
    const long = Array.from({ length: 40 }, (_, i) => `- step ${i + 1} of the plan`).join("\n");
    const html = renderToStaticMarkup(<ChatBubble role="assistant" text={long} agentSlug="operator" />);
    expect(html).toContain("step 40 of the plan");
    expect(html).not.toContain("Show full reply");
  });
});

describe("ChatBubble — over-cap reply is not repeated", () => {
  it("renders the full text once when the lead is its prefix", () => {
    const full = "Intro sentence here. " + "More detail. ".repeat(20) + "Final line.";
    const lead = full.slice(0, 60);
    const html = renderToStaticMarkup(
      <ChatBubble role="assistant" text={lead} fullReplyMarkdown={full} agentSlug="operator" />,
    );
    expect(html.split("Intro sentence here.").length - 1).toBe(1);
    expect(html).toContain("Final line.");
  });
});
