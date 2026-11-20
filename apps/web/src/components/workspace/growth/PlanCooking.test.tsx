// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  apiFetch: async () => new Response(JSON.stringify({ slots: [
    { key: "metric", answer: "More people finding us" },
    { key: "constraint", answer: "They look, but don't buy" },
    { key: "channels", answer: "Word of mouth from a customer, We paid for ads" },
  ] }), { status: 200 }),
}));
import { PlanCooking, minutesLine, toldUs } from "./PlanCooking";

afterEach(() => { cleanup(); window.localStorage.clear(); });

describe("PlanCooking", () => {
  it("reads back the setup picks, keeping a chip that holds a comma whole", () => {
    expect(toldUs([
      { key: "constraint", answer: "They look, but don't buy" },
      { key: "channels", answer: "Someone I already knew, Saw us on social" },
      { key: "customers", answer: "6-20" },
    ])).toEqual(["They look, but don't buy", "Someone I already knew", "Saw us on social"]);
  });
  it("counts the minutes down to Almost there", () => {
    expect(minutesLine(15)).toBe("About 15 minutes.");
    expect(minutesLine(1)).toBe("About a minute.");
    expect(minutesLine(0)).toBe("Almost there.");
  });
  it("shows what the founder told setup, 15 minutes left, and the alert choice", async () => {
    render(<PlanCooking tenant="t1" />);
    expect(screen.getByRole("heading", { name: "Zavi is cooking your plan" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("They look, but don't buy")).toBeTruthy());
    expect(screen.getByText("We paid for ads")).toBeTruthy();
    expect(screen.getByText("About 15 minutes.")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3");
    expect(screen.queryByText(/Stay here/)).toBeNull();
    expect(screen.getByRole("button", { name: "Allow notifications" })).toBeTruthy();
    screen.getByRole("button", { name: "or email me" }).click();
    await waitFor(() => expect(screen.getByText("We'll email you when it's ready.")).toBeTruthy());
    expect(window.localStorage.getItem("zavi:plan-alert:t1")).toBe("email");
  });
});
