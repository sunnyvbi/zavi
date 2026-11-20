// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { Toaster, toast } from "./toast";

class RO {
  observe() {}
  disconnect() {}
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function classes(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/);
}

describe("run-finished toast layout", () => {
  it("keeps a clear title/description hierarchy, a primary Review action, and a padded close target", () => {
    vi.stubGlobal("ResizeObserver", RO);
    render(<Toaster />);
    const onReview = vi.fn();
    act(() => {
      toast.add({
        type: "success",
        position: "top-right",
        title: "Zavi finished",
        description: "Ready for you to review.",
        timeout: 0,
        actionProps: { children: "Review", onClick: onReview },
      });
    });

    const title = screen.getByText("Zavi finished");
    const description = screen.getByText("Ready for you to review.");
    expect(classes(title)).toEqual(expect.arrayContaining(["text-[14px]", "font-semibold"]));
    expect(classes(description)).toContain("text-[13px]");
    expect(classes(title)).not.toContain("text-base");
    expect(classes(description)).not.toContain("text-base");

    const review = screen.getByRole("button", { name: "Review" });
    expect(classes(review)).toEqual(expect.arrayContaining(["bg-ink", "text-cream", "h-8", "self-center"]));
    expect(classes(review)).not.toContain("border");

    const close = screen.getByRole("button", { name: "Close toast" });
    expect(classes(close)).toEqual(expect.arrayContaining(["h-8", "w-8", "rounded-cta", "self-center"]));

    fireEvent.click(review);
    expect(onReview).toHaveBeenCalledTimes(1);
  });
});
