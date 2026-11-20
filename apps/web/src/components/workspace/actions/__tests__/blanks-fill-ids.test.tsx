// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

import { BlanksFill, type BlankFills } from "../BlanksFill";
import { fillBlanks } from "../blanks";

afterEach(cleanup);

const fills = (hint: string, from: string): BlankFills => {
  const blanks = [`[class: ${hint}]`, "[Studio name]"];
  const values = { "[Studio name]": `${from} studio` };
  return {
    blanks,
    values,
    known: { "[Studio name]": { value: `${from} studio`, from } },
    typed: {},
    set: () => undefined,
    left: 1,
    fill: (text) => fillBlanks(text, values),
  };
};

describe("two blank forms on one page", () => {
  it("each box is described by its own card's help text, never the other card's", () => {
    render(
      <>
        <BlanksFill fills={fills("the one Ana chose", "From card A")} />
        <BlanksFill fills={fills("the one Ben chose", "From card B")} />
      </>,
    );
    const cards = screen.getAllByTestId("blanks-fill");
    expect(cards).toHaveLength(2);
    const expected = [
      ["the one Ana chose", "From card A"],
      ["the one Ben chose", "From card B"],
    ];
    const ids: string[] = [];
    cards.forEach((card, i) => {
      const inputs = within(card).getAllByRole("textbox");
      expect(inputs).toHaveLength(2);
      expect(inputs[0]!.getAttribute("aria-describedby")).toBeNull();
      expect((inputs[0] as HTMLInputElement).placeholder).toBe(expected[i]![0]);
      inputs.slice(1).forEach((input) => {
        const id = input.getAttribute("aria-describedby");
        expect(id).toBeTruthy();
        ids.push(id!);
        const help = document.getElementById(id!);
        expect(help).not.toBeNull();
        expect(card.contains(help)).toBe(true);
        expect(input.closest("label")!.contains(help)).toBe(true);
        expect(help!.textContent).toBe(expected[i]![1]);
      });
    });
    expect(new Set(ids).size).toBe(2);
    expect(document.querySelectorAll("[id]").length).toBe(new Set([...document.querySelectorAll("[id]")].map((n) => n.id)).size);
  });
});
