// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { GrowthStartIntake } from "./GrowthStartIntake";

vi.mock("next/image", () => ({
  default: ({ unoptimized, ...props }: ComponentProps<"img"> & { unoptimized?: boolean }) => <img {...props} />,
}));

function Harness() {
  const [website, setWebsite] = useState("");
  return <GrowthStartIntake website={website} onWebsiteChange={setWebsite} error={null} onContinue={() => {}} />;
}

afterEach(cleanup);

const HINT = "Enter a website like acme.com";

describe("the hint under the Website URL box on /start", () => {
  it("says why Start is grey while the text is not a website yet", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Website URL");
    const start = screen.getByRole("button", { name: "Start" });
    expect(screen.queryByText(HINT)).toBeNull();

    fireEvent.change(input, { target: { value: "hello" } });
    expect(screen.getByText(HINT)).toBeTruthy();
    expect(start.hasAttribute("disabled")).toBe(true);
    expect(input.getAttribute("aria-describedby")).toContain("start-website-hint");

    fireEvent.change(input, { target: { value: "acme.com" } });
    expect(screen.queryByText(HINT)).toBeNull();
    expect(start.hasAttribute("disabled")).toBe(false);
  });
});
