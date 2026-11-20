// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChannelFitPill, ChannelValueLine } from "./ChannelValueLine";

describe("ChannelValueLine", () => {
  it("shows the strategy's rating on the pill and not its one-line reason", () => {
    const fit = { value: "low", line: "Renters book on Google and Turo, not Pinterest." } as const;
    render(
      <>
        <ChannelFitPill fit={fit} />
        <ChannelValueLine fit={fit} hasStrategy />
      </>,
    );
    expect(screen.getByTestId("channel-fit-pill").textContent).toBe("Low fit");
    expect(screen.queryByTestId("channel-value-line")).toBeNull();
    expect(screen.queryByText("Renters book on Google and Turo, not Pinterest.")).toBeNull();
  });

  it("no strategy: asks the founder to draft one, linking to it", () => {
    render(<ChannelValueLine fit={null} hasStrategy={false} />);
    expect(screen.getByTestId("channel-value-empty").textContent).toMatch(/hasn't judged this channel/);
    expect(screen.getByRole("link", { name: "Draft growth strategy" }).getAttribute("href")).toBe(
      "/workspace?tab=growth-strategy",
    );
  });

  it("an old strategy with no ratings: asks for a redraft", () => {
    render(<ChannelValueLine fit={null} hasStrategy />);
    expect(screen.getByRole("link", { name: "Redraft growth strategy" })).toBeTruthy();
  });
});
