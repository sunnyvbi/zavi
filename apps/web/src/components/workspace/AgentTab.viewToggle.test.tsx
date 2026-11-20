
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ViewModeToggle } from "./AgentTab";

function render(mode: "chat" | "threaded"): string {
  return renderToStaticMarkup(
    <ViewModeToggle mode={mode} onChange={() => {}} />,
  );
}

describe("ViewModeToggle", () => {
  it("offers BOTH views, each with its own accessible name", () => {
    const html = render("chat");
    expect(html).toContain('aria-label="Chat view"');
    expect(html).toContain('aria-label="Threaded view"');
  });

  it("renders real <button>s, not divs — so they are keyboard operable", () => {
    const html = render("chat");
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons.length).toBe(2);
    expect((html.match(/type="button"/g) ?? []).length).toBe(2);
    expect(html).not.toContain('role="button"');
  });

  it("marks exactly one option pressed, and it is the active one", () => {
    const chat = render("chat");
    expect((chat.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
    expect((chat.match(/aria-pressed="false"/g) ?? []).length).toBe(1);
    expect(chat).not.toContain("aria-current");

    const chatPressed = /aria-label="Chat view" aria-pressed="true"/.test(chat);
    expect(chatPressed).toBe(true);

    const threaded = render("threaded");
    expect(/aria-label="Threaded view" aria-pressed="true"/.test(threaded)).toBe(
      true,
    );
    expect(/aria-label="Chat view" aria-pressed="false"/.test(threaded)).toBe(
      true,
    );
  });

  it("groups the two options under one accessible group name", () => {
    const html = render("chat");
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Conversation view"');
  });

  it("hides the decorative icons from assistive tech", () => {
    const html = render("chat");
    expect((html.match(/<svg[^>]*aria-hidden/g) ?? []).length).toBe(2);
  });

  it("owns no outer gutter — spacing belongs to the controls cluster", () => {
    const html = render("chat");
    expect(html).not.toContain("pr-3");
  });

  it("is unshrinkable, so the thread strip can never squeeze it", () => {
    expect(render("chat")).toContain("shrink-0");
  });
});
