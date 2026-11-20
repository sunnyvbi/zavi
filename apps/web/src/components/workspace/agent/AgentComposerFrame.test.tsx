import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentComposerFrame } from "./AgentComposerFrame";

function render(agentSlug: string) {
  return renderToStaticMarkup(
    <AgentComposerFrame agentSlug={agentSlug} zavi={false} sidePanel={false}>
      <textarea aria-label="Message" />
    </AgentComposerFrame>,
  );
}

describe("AgentComposerFrame", () => {
  it("has no separator above the Engineer composer", () => {
    expect(render("engineer")).not.toContain("border-t");
  });

  it("keeps the separator on other agent chats", () => {
    expect(render("advisor")).toContain("border-t border-rule");
  });
});
