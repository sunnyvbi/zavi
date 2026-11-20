// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatBubble } from "./ChatBubble";
import { SideChatTypeContext } from "./sideChatType";

afterEach(cleanup);

const answer = "The Newsletter list has 3 people who can be emailed.";

function prose(text: string): HTMLElement {
  return screen.getByText(text).closest(".prose") as HTMLElement;
}

describe("the assistant's answer type face", () => {
  it("in the side chat beside a page it is the chrome face at the panel's 14px, not the serif", () => {
    render(
      <SideChatTypeContext.Provider value={true}>
        <ChatBubble role="assistant" text={answer} />
      </SideChatTypeContext.Provider>,
    );
    const el = prose(answer);
    expect(el.className).toContain("prose-p:text-[14px]");
    expect(el.className).not.toContain("prose-p:text-[16px]");
    expect(el.className).not.toContain("font-reading");
  });

  it("everywhere else it keeps the serif reading face at 16px", () => {
    render(<ChatBubble role="assistant" text={answer} />);
    const el = prose(answer);
    expect(el.className).toContain("font-reading");
    expect(el.className).toContain("prose-p:text-[16px]");
    expect(el.className).not.toContain("prose-p:text-[14px]");
  });
});
