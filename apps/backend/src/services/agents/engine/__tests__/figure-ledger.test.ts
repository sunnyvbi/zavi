
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordFigures,
  figureWasRead,
  ledgerIsEmpty,
  clearFigures,
  digitsOf,
  _figureCount,
  moneyRoundingWasRead,
  recordTrustedMoneyValue,
} from "../figure-ledger";

const RUN = "run-ledger-test";
beforeEach(() => clearFigures(RUN));

describe("figure ledger", () => {
  it("records numbers from a raw tool result in any format", () => {
    recordFigures(RUN, '{"subscribers":270219,"score":"4,832","rate":"12.5%"}');
    expect(figureWasRead(RUN, "270219")).toBe(true);
    expect(figureWasRead(RUN, "270,219")).toBe(true);
    expect(figureWasRead(RUN, "4832")).toBe(true);
    expect(figureWasRead(RUN, "998")).toBe(false);
  });

  it("is empty until something is recorded, which is how the gate stays off", () => {
    expect(ledgerIsEmpty(RUN)).toBe(true);
    expect(figureWasRead(RUN, "123")).toBe(false);
    recordFigures(RUN, "99 problems");
    expect(ledgerIsEmpty(RUN)).toBe(false);
  });

  it("ignores single digits so the ledger does not become a wildcard", () => {
    recordFigures(RUN, "we found 7 things");
    expect(_figureCount(RUN)).toBe(0);
    expect(figureWasRead(RUN, "7")).toBe(false);
  });

  it("separates runs", () => {
    recordFigures(RUN, "270219");
    expect(figureWasRead("other-run", "270219")).toBe(false);
  });

  it("clears", () => {
    recordFigures(RUN, "270219");
    clearFigures(RUN);
    expect(ledgerIsEmpty(RUN)).toBe(true);
  });

  it("digitsOf strips separators and currency", () => {
    expect(digitsOf("$4,832,820.00")).toBe("4832820" + "00");
    expect(digitsOf("1 414")).toBe("1414");
  });

  it("stays bounded on a result full of numbers", () => {
    recordFigures(RUN, Array.from({ length: 60_000 }, (_, i) => String(i + 100)).join(" "));
    expect(_figureCount(RUN)).toBeLessThanOrEqual(50_000);
  });
});

describe("recordTrustedMoneyValue / moneyRoundingWasRead (BUG2)", () => {
  it("keys a 3+ place value as its signed two-place rounding, exactly", () => {
    recordTrustedMoneyValue(RUN, 37.0917);
    recordTrustedMoneyValue(RUN, -12.4612);
    recordTrustedMoneyValue(RUN, 1.005);
    expect(moneyRoundingWasRead(RUN, "37.09", false)).toBe(true);
    expect(moneyRoundingWasRead(RUN, "37.09", true)).toBe(false);
    expect(moneyRoundingWasRead(RUN, "12.46", true)).toBe(true);
    expect(moneyRoundingWasRead(RUN, "12.46", false)).toBe(false);
    expect(moneyRoundingWasRead(RUN, "1.01", false)).toBe(true);
  });
  it("ignores exact two-place values, exponents and non-finite numbers, and is dropped with the run", () => {
    recordTrustedMoneyValue(RUN, 25.46);
    recordTrustedMoneyValue(RUN, 1.2345e-7);
    recordTrustedMoneyValue(RUN, Number.NaN);
    expect(moneyRoundingWasRead(RUN, "25.46", false)).toBe(false);
    expect(moneyRoundingWasRead(RUN, "1.23", false)).toBe(false);
    recordTrustedMoneyValue(RUN, 37.0917);
    clearFigures(RUN);
    expect(moneyRoundingWasRead(RUN, "37.09", false)).toBe(false);
  });
  it("scraped text never creates a key: ids, ranges, exponents and other locales in a tool result", () => {
    recordFigures(RUN, '{"id":370917,"range":"10-12.3456","tiny":1.2345e-7,"eu":"1.234,57","delta_pct":-12.4612}');
    for (const [a, n] of [["37.09", false], ["12.35", true], ["1.23", false], ["12.46", true], ["12.46", false]] as const) {
      expect(moneyRoundingWasRead(RUN, a, n)).toBe(false);
    }
  });
});
