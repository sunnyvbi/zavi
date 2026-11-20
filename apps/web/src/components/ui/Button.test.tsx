// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Button } from "./Button";

afterEach(cleanup);

const tokens = (name: string) => screen.getByRole("button", { name }).className.split(/\s+/);

describe("Button sizing", () => {
  it("gives a plain button the 40px CTA height and padding", () => {
    render(<Button>Try again</Button>);
    expect(tokens("Try again")).toEqual(expect.arrayContaining(["h-10", "px-4"]));
  });

  it("keeps layout classes from callers without dropping the default size", () => {
    render(<Button className="mt-4 ml-auto">Download</Button>);
    expect(tokens("Download")).toEqual(expect.arrayContaining(["h-10", "px-4", "mt-4", "ml-auto"]));
  });

  it("lets a caller's own padding size the button, so the dismiss X stays a small square", () => {
    render(
      <Button className="border-0 bg-transparent p-1 text-danger" aria-label="Dismiss error">
        x
      </Button>,
    );
    const t = tokens("Dismiss error");
    expect(t).toContain("p-1");
    expect(t).not.toContain("h-10");
    expect(t).not.toContain("px-4");
  });

  it.each(["h-8", "size-8", "py-2", "px-2", "sm:h-12"])("drops the default size when the caller passes %s", (cls) => {
    render(<Button className={cls}>Go</Button>);
    const t = tokens("Go");
    expect(t).toContain(cls);
    expect(t).not.toContain("h-10");
    expect(t).not.toContain("px-4");
  });
});
