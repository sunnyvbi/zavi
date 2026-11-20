// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CookingBar } from "./CookingBar";
afterEach(cleanup);

describe("CookingBar", () => {
  it.each([20, 50, 100] as const)("shows %i%% and says cooking until the draft lands", (pct) => {
    render(<CookingBar pct={pct} />);
    expect(screen.getByText("Growth strategy is cooking")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(String(pct));
  });

  it("says the strategy is ready once the draft has landed", () => {
    render(<CookingBar pct={100} ready />);
    expect(screen.getByText("Growth strategy is ready")).toBeTruthy();
    expect(screen.queryByText("Growth strategy is cooking")).toBeNull();
  });

  it("while the draft waits on a file: says so, with the read's sub line, and no read percentage", () => {
    render(<CookingBar pct={90} waiting sub="Reading zavi-context.md. The draft starts the moment it's done." />);
    expect(screen.getByText("Waiting for your file")).toBeTruthy();
    expect(screen.getByText("Reading zavi-context.md. The draft starts the moment it's done.")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("90");
  });
});
