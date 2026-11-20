// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  BUILD_SURFACE_TABS_WIDTH,
  BuildSurfaceTabs,
  FALLBACK_LABEL_PX,
  SLIDE_MS,
  indicatorOffset,
  selectedTabWidth,
} from "./BuildSurfaceTabs";

afterEach(cleanup);

const tab = (name: string) => screen.getByRole("tab", { name }) as HTMLElement;
const label = (name: string) =>
  Array.from(tab(name).querySelectorAll("span")).find((s) => s.textContent === name)!;

describe("BuildSurfaceTabs", () => {
  it("fits the selected pill to its own label instead of one wide size for every tab", () => {
    const { rerender } = render(<BuildSurfaceTabs active="preview" onChange={() => {}} />);
    expect(tab("Preview").style.width).toBe(`${selectedTabWidth(FALLBACK_LABEL_PX.preview)}px`);
    rerender(<BuildSurfaceTabs active="files" onChange={() => {}} />);
    expect(tab("Files").style.width).toBe(`${selectedTabWidth(FALLBACK_LABEL_PX.files)}px`);
    expect(selectedTabWidth(FALLBACK_LABEL_PX.files)).toBeLessThan(selectedTabWidth(FALLBACK_LABEL_PX.preview));
    expect(tab("Preview").style.width).toBe("30px");
  });

  it("never grows past the slot the headers reserve for it", () => {
    for (const px of Object.values(FALLBACK_LABEL_PX)) {
      expect(selectedTabWidth(px) + 30 * 2 + 5 * 2 + 6).toBeLessThanOrEqual(BUILD_SURFACE_TABS_WIDTH);
    }
  });

  it("slides and resizes the pill on one curve, in step with the tabs", () => {
    const { rerender } = render(<BuildSurfaceTabs active="preview" onChange={() => {}} />);
    const pill = screen.getByTestId("tab-indicator");
    rerender(<BuildSurfaceTabs active="code" onChange={() => {}} />);
    expect(pill.style.transform).toBe(`translateX(${indicatorOffset(2)}px)`);
    expect(pill.style.width).toBe(`${selectedTabWidth(FALLBACK_LABEL_PX.code)}px`);
    expect(pill.style.transition).toContain(`transform ${SLIDE_MS}ms`);
    expect(pill.style.transition).toContain(`width ${SLIDE_MS}ms`);
    expect(tab("Code").style.transition).toContain(`width ${SLIDE_MS}ms`);
  });

  it("fades the new label in after the slide starts and the old one out quickly", () => {
    render(<BuildSurfaceTabs active="files" onChange={() => {}} />);
    expect(label("Files").className).toContain("opacity-100");
    expect(label("Files").className).toContain("delay-[120ms]");
    expect(label("Preview").className).toContain("opacity-0");
    expect(label("Preview").className).not.toContain("delay-");
  });

  it("keeps everything still for people who ask for less motion", () => {
    render(<BuildSurfaceTabs active="preview" onChange={() => {}} />);
    expect(screen.getByTestId("tab-indicator").className).toContain("motion-reduce:!transition-none");
    expect(tab("Preview").className).toContain("motion-reduce:!transition-none");
    expect(label("Preview").className).toContain("motion-reduce:!transition-none");
  });

  it("moves with the arrow keys and wraps around", () => {
    const onChange = vi.fn();
    render(<BuildSurfaceTabs active="preview" onChange={onChange} />);
    fireEvent.keyDown(tab("Preview"), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("code");
  });

  it("keeps settings out of the Preview, Files and Code control", () => {
    render(<BuildSurfaceTabs active="preview" onChange={() => {}} />);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label"))).toEqual(["Preview", "Files", "Code"]);
    expect(screen.queryByRole("tab", { name: "More" })).toBeNull();
  });
});
