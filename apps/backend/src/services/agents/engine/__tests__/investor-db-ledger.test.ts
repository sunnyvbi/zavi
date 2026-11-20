
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordInvestorDbResults,
  isFromInvestorDb,
  investorDbLedgerSize,
  clearInvestorDbLedger,
  canonicalFirm,
  normalizeName,
  __resetInvestorDbLedgerForTest,
} from "../investor-db-ledger";

const RUN = "run-invdb";

describe("investor-db result ledger", () => {
  beforeEach(() => __resetInvestorDbLedgerForTest());

  it("recognizes a (firm,name) that investor_db__search really returned", () => {
    recordInvestorDbResults(RUN, [
      { name: "Jane Partner", primary_firm: "Acme Ventures" },
      { name: "Sam Lead", primary_firm: "Northwind Capital" },
    ]);
    expect(investorDbLedgerSize(RUN)).toBe(2);
    expect(isFromInvestorDb(RUN, "Acme Capital", "JANE  PARTNER")).toBe(true);
    expect(isFromInvestorDb(RUN, "Northwind Ventures", "Sam Lead")).toBe(true);
  });

  it("does NOT recognize a (firm,name) that was never returned (fabricated)", () => {
    recordInvestorDbResults(RUN, [{ name: "Jane", primary_firm: "Acme Ventures" }]);
    expect(isFromInvestorDb(RUN, "Fabricated Capital", "Ghost")).toBe(false);
    expect(isFromInvestorDb(RUN, "Acme Ventures", "Someone Else")).toBe(false);
  });

  it("accepts the `firm` field too (forward-compat) and skips empty rows", () => {
    recordInvestorDbResults(RUN, [
      { name: "Lee", firm: "Bedrock Partners" },
      { name: "", primary_firm: "" },
    ]);
    expect(investorDbLedgerSize(RUN)).toBe(1);
    expect(isFromInvestorDb(RUN, "Bedrock", "Lee")).toBe(true);
  });

  it("is run-scoped — another run does not see this run's keys", () => {
    recordInvestorDbResults(RUN, [{ name: "Jane", primary_firm: "Acme Ventures" }]);
    expect(isFromInvestorDb("other-run", "Acme Ventures", "Jane")).toBe(false);
    expect(investorDbLedgerSize("other-run")).toBe(0);
  });

  it("reports an empty ledger when nothing was recorded (drives the fallback)", () => {
    expect(investorDbLedgerSize(RUN)).toBe(0);
    expect(isFromInvestorDb(RUN, "Acme Ventures", "Jane")).toBe(false);
  });

  it("clearInvestorDbLedger drops the run's keys", () => {
    recordInvestorDbResults(RUN, [{ name: "Jane", primary_firm: "Acme Ventures" }]);
    clearInvestorDbLedger(RUN);
    expect(investorDbLedgerSize(RUN)).toBe(0);
    expect(isFromInvestorDb(RUN, "Acme Ventures", "Jane")).toBe(false);
  });

  it("exported canonicalFirm/normalizeName match the post-run dedup semantics", () => {
    expect(canonicalFirm("Acme Ventures")).toBe("acme");
    expect(canonicalFirm("Acme Capital Partners")).toBe("acme");
    expect(normalizeName("  Jane   PARTNER ")).toBe("jane partner");
  });

  it("no-ops on missing run_id or non-array rows", () => {
    recordInvestorDbResults("", [{ name: "X", primary_firm: "Y Capital" }]);
    expect(investorDbLedgerSize("")).toBe(0);
    recordInvestorDbResults(RUN, null);
    expect(investorDbLedgerSize(RUN)).toBe(0);
  });
});
