// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CopyText } from "./CopyText";
import { Steps } from "./Steps";
import { LabeledFields } from "../../organic/blocks/LabeledFields";
import { ContextCopy } from "../../organic/blocks/ContextCopy";
import { groupMetaLine } from "../groupMeta";

afterEach(cleanup);

describe("compact action-card content", () => {
  it("keeps short copy fully visible without an extra control", () => {
    render(<CopyText text="A short, readable draft." />);
    expect(screen.getByText("A short, readable draft.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Read more" })).toBeNull();
  });

  it("clamps a long draft by whole lines, keeps all its text, and has no Read more control", () => {
    const text = Array.from({ length: 8 }, (_, index) => `Paragraph ${index + 1}: ${"useful detail ".repeat(8)}`).join("\n\n");
    render(<CopyText text={text} />);
    const body = screen.getByTestId("card-copy-text");
    expect(body.getAttribute("data-clipped")).toBe("true");
    expect(body.querySelector("p")?.className).toContain("line-clamp-6");
    expect(body.textContent).toContain("Paragraph 8:");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders dashed lines as real bullets when the card asks for lists", () => {
    render(<CopyText text={"Context hints:\n- First hint\n- Second hint"} lists />);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["First hint", "Second hint"]);
    expect(screen.getByText("Context hints:")).toBeTruthy();
  });

  it("keeps dashed lines as written when the text is a draft to post", () => {
    render(<CopyText text={"Launch notes:\n- First\n- Second"} />);
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("shows three action points and no Read more control", () => {
    render(<Steps lead="Why this matters." points={["One", "Two", "Three", "Four", "Five"]} />);
    expect(screen.getByText("Three")).toBeTruthy();
    expect(screen.queryByText("Four")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps a long brief to four fields with no Read more control", () => {
    const fields = Array.from({ length: 6 }, (_, index) => ({ label: `Field ${index + 1}`, content: `Value ${index + 1}` }));
    render(<LabeledFields fields={fields} />);
    expect(screen.getByText("Field 4")).toBeTruthy();
    expect(screen.queryByText("Field 5")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps grouped-suggestion context short enough for the eyebrow row", () => {
    expect(groupMetaLine(0, 3, "profile")).toBe("1 of 3 · Same profile");
  });

  it("keeps reply context to two lines while preserving the full text as its title", () => {
    const label = `A very long source post: ${"context ".repeat(40)}`;
    const { container } = render(<ContextCopy label={label} text="A concise reply." />);
    const context = container.querySelector("p[title]") as HTMLParagraphElement | null;
    expect(context).toBeTruthy();
    expect(context?.className).toContain("line-clamp-2");
    expect(context?.getAttribute("title")).toBe(label);
  });
});
