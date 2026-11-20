// @vitest-environment jsdom

import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { MobileIconButton } from "./MobileIconButton";

afterEach(cleanup);

describe("MobileIconButton", () => {
  it("meets the 44px tap-target floor", () => {
    render(<MobileIconButton label="Menu">x</MobileIconButton>);
    const button = screen.getByRole("button", { name: "Menu" });
    expect(button.className).toContain("h-12");
    expect(button.className).toContain("w-12");
  });

  it("has no hover state — a sticky :hover after a tap looks pressed", () => {
    render(<MobileIconButton label="Menu">x</MobileIconButton>);
    const button = screen.getByRole("button", { name: "Menu" });
    expect(button.className).not.toContain("hover:");
    expect(button.className).toContain("active:");
  });

  it("names itself for screen readers, since it is icon-only", () => {
    render(<MobileIconButton label="Open navigation">x</MobileIconButton>);
    expect(
      screen.getByRole("button", { name: "Open navigation" }),
    ).toBeTruthy();
  });
});
