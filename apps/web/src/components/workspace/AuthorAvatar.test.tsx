
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AuthorAvatar } from "./AuthorAvatar";

describe("AuthorAvatar", () => {
  it("renders the initial on ink when there is no photo — never a generated face", () => {
    const html = renderToStaticMarkup(<AuthorAvatar label="You" size="ml" />);
    expect(html).toContain(">Y<");
    expect(html).toContain("bg-ink");
    expect(html).not.toContain("dicebear");
    expect(html).not.toContain("<img");
  });

  it("renders the real photo when the payload carries one", () => {
    const html = renderToStaticMarkup(
      <AuthorAvatar label="You" photoUrl="https://example.com/me.png" size="ml" />,
    );
    expect(html).toContain("<img");
    expect(html).toContain("https://example.com/me.png");
    expect(html).not.toContain(">Y<");
  });

  it("sizes to 32px for the thread/feed row (Figma 1:1275)", () => {
    expect(renderToStaticMarkup(<AuthorAvatar label="You" size="ml" />)).toContain(
      "h-8 w-8",
    );
    expect(renderToStaticMarkup(<AuthorAvatar label="You" />)).toContain(
      "h-7 w-7",
    );
  });

  it("uses the first letter of the label, uppercased", () => {
    expect(renderToStaticMarkup(<AuthorAvatar label="ravi" />)).toContain(">R<");
    expect(renderToStaticMarkup(<AuthorAvatar label="  " />)).toContain(">?<");
  });
});
