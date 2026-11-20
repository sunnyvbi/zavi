// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PickedElementChip, pickedElementLabel } from "./PickedElementChip";

afterEach(cleanup);

describe("pickedElementLabel", () => {
  it("uses the element's own words, shortened", () => {
    expect(pickedElementLabel({ tag: "h1", text: "  Rent   bikes fast " })).toBe("Rent bikes fast");
    expect(pickedElementLabel({ tag: "p", text: "x".repeat(80) })).toHaveLength(40);
  });

  it("falls back to the kind of element, then its tag", () => {
    expect(pickedElementLabel({ tag: "img", text: "" })).toBe("Image");
    expect(pickedElementLabel({ tag: "section", text: null })).toBe("Section");
    expect(pickedElementLabel({ tag: "my-card", text: null })).toBe("<my-card>");
  });
});

describe("PickedElementChip", () => {
  it("names the element and its page, and its × unpicks it", () => {
    const onRemove = vi.fn();
    render(<PickedElementChip pick={{ tag: "h1", text: "Rent bikes fast", path: "/about" }} onRemove={onRemove} />);
    const chip = screen.getByTestId("picked-element-chip");
    expect(chip.textContent).toContain("Rent bikes fast");
    expect(chip.textContent).toContain("/about");
    fireEvent.click(screen.getByRole("button", { name: "Remove selected heading" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("draws only an https thumbnail, without a referrer, and none for other addresses", () => {
    const { container, rerender } = render(<PickedElementChip pick={{ tag: "img", thumb: "https://cdn.example/a.png" }} />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://cdn.example/a.png");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    rerender(<PickedElementChip pick={{ tag: "img", thumb: "javascript:alert(1)" }} />);
    expect(container.querySelector("img")).toBeNull();
  });

  it("has no remove button on a sent turn", () => {
    render(<PickedElementChip pick={{ tag: "a", text: "Book now" }} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
