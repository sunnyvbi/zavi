
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  recordGroundingReceipt,
  groundingReceipts,
  clearGroundingReceipts,
  __resetGroundingReceiptsForTest,
} from "../../engine/grounding-receipt-ledger";

const RUN_AGENT_SRC = join(
  __dirname,
  "../../../../../workers/functions/run-agent.ts",
);

describe("invariant: grounding ledger cannot stale-certify a retry", () => {
  beforeEach(() => {
    __resetGroundingReceiptsForTest();
  });

  describe("teardown wiring (RED pre-fix)", () => {
    const src = readFileSync(RUN_AGENT_SRC, "utf8");

    it("run-agent imports clearGroundingReceipts", () => {
      expect(src).toMatch(
        /import\s*\{[^}]*clearGroundingReceipts[^}]*\}\s*from\s*["'][^"']*grounding-receipt-ledger["']/,
      );
    });

    it("run-agent CALLS clearGroundingReceipts(run_id) at teardown", () => {
      expect(src).toMatch(/clearGroundingReceipts\(\s*run_id\s*\)/);
    });

    it("clears the grounding ledger alongside its sibling process-local ledgers", () => {
      for (const sibling of [
        "clearCaptureLedger",
        "clearInvestorDbLedger",
        "_clearRunBrowserState",
      ]) {
        expect(src).toContain(`${sibling}(run_id)`);
      }
      expect(src).toContain("clearGroundingReceipts(run_id)");
    });
  });

  describe("retry semantics the wiring protects", () => {
    it("a cleared run reports NO receipts, so the gate fail-closes on attempt 2", () => {
      const run_id = "run-retry-fixture";

      recordGroundingReceipt(run_id, "github__read_file");
      expect(groundingReceipts(run_id).has("repo_read")).toBe(true);

      clearGroundingReceipts(run_id);

      expect(groundingReceipts(run_id).size).toBe(0);
      expect(groundingReceipts(run_id).has("repo_read")).toBe(false);
    });

    it("clearing one run does not disturb a concurrent run's receipts", () => {
      recordGroundingReceipt("run-a", "github__read_file");
      recordGroundingReceipt("run-b", "github__list_commits");

      clearGroundingReceipts("run-a");

      expect(groundingReceipts("run-a").size).toBe(0);
      expect(groundingReceipts("run-b").has("repo_history")).toBe(true);
    });

    it("an empty search mints NO receipt (pre-existing rule, pinned here)", () => {
      recordGroundingReceipt("run-empty", "github__search_code", false);
      expect(groundingReceipts("run-empty").size).toBe(0);
    });
  });
});
