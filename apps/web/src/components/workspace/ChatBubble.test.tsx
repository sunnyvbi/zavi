import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { bubbleRenderShape } from "./chatBubbleShape";
import { ChatBubble } from "./ChatBubble";

describe("ChatBubble — bubbleRenderShape decision (real export)", () => {
  it("user role → plain-text (preserves verbatim text including HTML-shaped tags)", () => {
    expect(bubbleRenderShape("user")).toBe("plain-text");
  });

  it("assistant role → markdown (full sanitized rendering)", () => {
    expect(bubbleRenderShape("assistant")).toBe("markdown");
  });

  it("system role → system-italic (centered italic announcement)", () => {
    expect(bubbleRenderShape("system")).toBe("system-italic");
  });
});

describe("ChatBubble — user input preservation contract (generalized)", () => {
  it("user role always returns plain-text regardless of input shape", () => {
    expect(bubbleRenderShape("user")).toBe("plain-text");
  });
});

function findElement(
  node: ReactNode,
  match: (el: ReactElement<any>) => boolean,
): ReactElement<any> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, match);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (match(node)) return node;
  const children = (node.props as { children?: ReactNode }).children;
  return findElement(children, match);
}

describe("ChatBubble — user-message Edit affordance (June-8 F)", () => {
  it("renders an 'Edit message' button when onEdit is provided + text is non-empty; clicking fires onEdit once", () => {
    const onEdit = vi.fn();
    const html = renderToStaticMarkup(
      <ChatBubble role="user" text="scale gig rentals to $144" onEdit={onEdit} />,
    );
    expect(html).toContain('aria-label="Edit message"');

    const tree = ChatBubble({
      role: "user",
      text: "scale gig rentals to $144",
      onEdit,
    });
    const editEl = findElement(
      tree,
      (el) => typeof (el.props as { onEdit?: unknown }).onEdit === "function",
    );
    expect(editEl).not.toBeNull();
    (editEl!.props as { onEdit: () => void }).onEdit();
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("renders NO Edit button when onEdit is undefined", () => {
    const html = renderToStaticMarkup(
      <ChatBubble role="user" text="some message" />,
    );
    expect(html).not.toContain('aria-label="Edit message"');
  });

  it("renders NO Edit button for empty / whitespace-only text even with onEdit", () => {
    const emptyHtml = renderToStaticMarkup(
      <ChatBubble role="user" text="" onEdit={() => {}} />,
    );
    expect(emptyHtml).not.toContain('aria-label="Edit message"');

    const whitespace = " " + String.fromCharCode(9, 10) + "  ";
    const wsHtml = renderToStaticMarkup(
      <ChatBubble role="user" text={whitespace} onEdit={() => {}} />,
    );
    expect(wsHtml).not.toContain('aria-label="Edit message"');
  });
});

describe("ChatBubble — streaming-draft in-progress affordance (2026-06-16)", () => {
  it("isStreaming assistant: shows the working row + sr-only status, hides Copy", () => {
    const html = renderToStaticMarkup(
      <ChatBubble
        role="assistant"
        text="DB returned 0 — retrying with simpler tags"
        agentSlug="fundraising"
        isStreaming
      />,
    );
    expect(html).toContain("working");
    expect(html).toContain('role="status"');
    expect(html).toContain("Assistant is still responding");
    expect(html).not.toContain('aria-label="Copy message"');
  });

  it("settled assistant (default): shows Copy, no in-progress row", () => {
    const html = renderToStaticMarkup(
      <ChatBubble
        role="assistant"
        text="Here is your tiered investor list."
        agentSlug="fundraising"
      />,
    );
    expect(html).toContain('aria-label="Copy message"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("Assistant is still responding");
  });
});

describe("ChatBubble — user variant: bubble (default) vs flat (thread)", () => {
  const TEXT = "Give me a one-paragraph status update.";

  it("default variant keeps the right-aligned pill (main chat feed unchanged)", () => {
    const html = renderToStaticMarkup(<ChatBubble role="user" text={TEXT} />);
    expect(html).toContain("items-end");
    expect(html).toContain("bg-[#f0f0f0]");
    expect(html).toContain(TEXT);
  });

  it("flat variant drops the pill and right-alignment entirely", () => {
    const html = renderToStaticMarkup(
      <ChatBubble role="user" text={TEXT} variant="flat" />,
    );
    expect(html).not.toContain("items-end");
    expect(html).not.toContain("bg-[#f0f0f0]");
    expect(html).toContain(TEXT);
  });

  it("flat variant labels the author, so a reply is never mistaken for the ask", () => {
    const html = renderToStaticMarkup(
      <ChatBubble role="user" text={TEXT} variant="flat" />,
    );
    expect(html).toContain("You");
  });

  it("flat variant renders the timestamp beside the author name", () => {
    const html = renderToStaticMarkup(
      <ChatBubble
        role="user"
        text={TEXT}
        variant="flat"
        createdAt="2026-07-18T10:30:00.000Z"
      />,
    );
    expect(html).toContain("title=");
  });

  it("user text stays VERBATIM in flat shape — no markdown sanitizer", () => {
    const html = renderToStaticMarkup(
      <ChatBubble role="user" text="<plan>ship it</plan>" variant="flat" />,
    );
    expect(html).toContain("&lt;plan&gt;ship it&lt;/plan&gt;");
  });
});
