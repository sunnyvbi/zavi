// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RedditClampedBody } from "./RedditClampedBody";

afterEach(() => cleanup());

describe("RedditClampedBody", () => {
  it("clamps a long body until expanded", () => {
    const text = "word ".repeat(120).trim();
    render(<RedditClampedBody text={text} label="reply" className="" />);
    expect(screen.getByText(text).className).toContain("line-clamp-5");
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText(text).className).not.toContain("line-clamp-5");
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("shows a short body in full with no toggle", () => {
    render(<RedditClampedBody text="Short reply." label="reply" className="" />);
    expect(screen.getByText("Short reply.").className).not.toContain("line-clamp-5");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
