// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_CUSTOMERS, EarningsCalculator, estimate } from "./EarningsCalculator";
import { AFFILIATE_PLANS, firstTwo, laterTen, usd, yearOne } from "./terms";

afterEach(cleanup);

describe("affiliate commission math", () => {
  it("pays two full months, then 30% for ten more", () => {
    const byPlan = Object.fromEntries(AFFILIATE_PLANS.map((p) => [p.id, [firstTwo(p.price), laterTen(p.price), yearOne(p.price)]]));
    expect(byPlan).toEqual({
      starter: [40, 60, 100],
      growth: [240, 360, 600],
      pro: [480, 720, 1200],
    });
  });

  it("scales by customer count", () => {
    expect(estimate(120, 10)).toEqual({ first: 2400, year: 6000 });
    expect(estimate(20, 1)).toEqual({ first: 40, year: 100 });
  });

  it("formats whole dollars without cents", () => {
    expect(usd(1200)).toBe("$1,200");
    expect(usd(6)).toBe("$6");
  });
});

describe("EarningsCalculator", () => {
  it("defaults to Growth with 10 customers", () => {
    render(<EarningsCalculator />);
    expect(screen.getByRole("radio", { name: /Growth/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText(/Customers you refer/)).toHaveProperty("value", String(DEFAULT_CUSTOMERS));
    expect(screen.getByTestId("calc-first").textContent).toBe("$2,400");
    expect(screen.getByTestId("calc-year").textContent).toBe("$6,000");
  });

  it("recomputes on plan change and slider move", () => {
    render(<EarningsCalculator />);
    fireEvent.click(screen.getByRole("radio", { name: /Pro/ }));
    expect(screen.getByRole("radio", { name: /Pro/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /Growth/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("calc-year").textContent).toBe("$12,000");

    fireEvent.change(screen.getByLabelText(/Customers you refer/), { target: { value: "3" } });
    expect(screen.getByTestId("calc-count").textContent).toBe("3");
    expect(screen.getByTestId("calc-first").textContent).toBe("$1,440");
    expect(screen.getByTestId("calc-year").textContent).toBe("$3,600");
  });
});
