import { describe, expect, it } from "vitest";
import { postContent } from "../types";
import { makeAction } from "./fixtures";

const deliverable = (kind: string, content: string) =>
  makeAction(kind === "comment" ? "reply" : "text_post", {
    body: { step: { deliverable: { kind, content } } },
  } as never);

describe("postContent splits a multi-part deliverable", () => {
  it("splits a thread on its --- lines, so each part is measured alone", () => {
    const { text, thread } = postContent(deliverable("thread", "Part one.\n---\nPart two.\n---\nPart three."));
    expect(text).toBe("Part one.");
    expect(thread).toEqual(["Part two.", "Part three."]);
  });

  it("splits a reply kit, the case that showed 633 / 280 on a card", () => {
    const openers = [
      `When they post about A:\n${"a".repeat(200)}`,
      `When they post about B:\n${"b".repeat(200)}`,
      `When they post about C:\n${"c".repeat(200)}`,
    ];
    const { text, thread } = postContent(deliverable("comment", openers.join("\n---\n")));
    const parts = [text, ...(thread ?? [])];
    expect(parts).toHaveLength(3);
    expect(openers.join("\n---\n").length).toBeGreaterThan(280);
    expect(parts.every((p) => p.length <= 280)).toBe(true);
  });

  it("leaves a single post alone, dashes and all", () => {
    const { text, thread } = postContent(deliverable("post", "A post that has --- dashes mid-line."));
    expect(text).toBe("A post that has --- dashes mid-line.");
    expect(thread).toBeNull();
  });

  it("does not split a kind that never uses the separator", () => {
    const { text, thread } = postContent(deliverable("page_copy", "Line one.\n---\nLine two."));
    expect(text).toBe("Line one.\n---\nLine two.");
    expect(thread).toBeNull();
  });

  it("keeps an explicit thread array ahead of the separator", () => {
    const a = makeAction("text_post", {
      body: { thread: ["Given part."], step: { deliverable: { kind: "thread", content: "Root.\n---\nIgnored." } } },
    } as never);
    expect(postContent(a).thread).toEqual(["Given part."]);
  });
});

describe("postContent reads explicit deliverable parts", () => {
  it("labels every opener with its part and never mixes two parts", () => {
    const kit = (x: string) => [`Opener ${x}1.`, `Opener ${x}2.`, `Opener ${x}3.`].join("\n---\n");
    const parts = [
      { label: "@first", content: kit("a") },
      { label: "@second", content: kit("b") },
    ];
    const a = makeAction("reply", {
      body: {
        step: {
          deliverable: {
            kind: "comment",
            content: parts.map((p) => `${p.label}\n${p.content}`).join("\n\n"),
            parts,
          },
        },
      },
    } as never);
    const { text, thread } = postContent(a);
    const all = [text, ...(thread ?? [])];
    expect(all).toHaveLength(6);
    all.slice(0, 3).forEach((t, i) => expect(t).toBe(`@first\nOpener a${i + 1}.`));
    all.slice(3).forEach((t, i) => expect(t).toBe(`@second\nOpener b${i + 1}.`));
    expect(all.some((t) => t.includes("Opener a") && t.includes("Opener b"))).toBe(false);
  });
});
