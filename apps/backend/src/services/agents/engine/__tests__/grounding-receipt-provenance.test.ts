
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordGroundingReceipt,
  groundingReceipts,
  hasShippedCodeReceipt,
  isDocOnlyGrounded,
  __resetGroundingReceiptsForTest,
} from "../grounding-receipt-ledger";

const SPEC = "docs/superpowers/specs/2026-09-11-cohost-earnings-split-spec.md";
const CODE = "apps/backend/src/services/cohostSplit/splitMath.ts";

describe("receipts distinguish the plan from the system", () => {
  beforeEach(() => __resetGroundingReceiptsForTest());

  it("a doc read still counts as reading the repo — but not as reading code", () => {
    recordGroundingReceipt("r1", "github__read_file", true, "doc");
    const r = groundingReceipts("r1");
    expect(r.has("repo_read")).toBe(true);
    expect(r.has("repo_doc_read")).toBe(true);
    expect(r.has("repo_source_read")).toBe(false);
    expect(hasShippedCodeReceipt("r1")).toBe(false);
    expect(isDocOnlyGrounded("r1")).toBe(true);
  });

  it("a source read licenses a present-tense claim", () => {
    recordGroundingReceipt("r2", "github__read_file", true, "source");
    expect(hasShippedCodeReceipt("r2")).toBe(true);
    expect(isDocOnlyGrounded("r2")).toBe(false);
  });

  it("replays the incident: many doc reads, zero source reads, still doc-only", () => {
    for (let i = 0; i < 8; i++) {
      recordGroundingReceipt("r3", "github__read_file", true, "doc");
    }
    recordGroundingReceipt("r3", "github__search_code", true, null);
    expect(groundingReceipts("r3").has("repo_read")).toBe(true);
    expect(isDocOnlyGrounded("r3")).toBe(true);
    expect(hasShippedCodeReceipt("r3")).toBe(false);
  });

  it("one real source read is enough to stop being doc-only", () => {
    recordGroundingReceipt("r4", "github__read_file", true, "doc");
    recordGroundingReceipt("r4", "github__read_file", true, "source");
    expect(isDocOnlyGrounded("r4")).toBe(false);
    expect(hasShippedCodeReceipt("r4")).toBe(true);
  });

  it("tests and build output are not shipped code either", () => {
    recordGroundingReceipt("r5", "github__read_file", true, "test");
    recordGroundingReceipt("r6", "github__read_file", true, "generated");
    expect(hasShippedCodeReceipt("r5")).toBe(false);
    expect(hasShippedCodeReceipt("r6")).toBe(false);
    expect(isDocOnlyGrounded("r5")).toBe(true);
  });

  it("a search alone leaves the pair untouched — it named no file to classify", () => {
    recordGroundingReceipt("r7", "github__search_code", true, null);
    const r = groundingReceipts("r7");
    expect(r.has("repo_read")).toBe(true);
    expect(r.has("repo_doc_read")).toBe(false);
    expect(r.has("repo_source_read")).toBe(false);
    expect(isDocOnlyGrounded("r7")).toBe(false);
  });

  it("omitting sourceKind is byte-identical to the old behaviour", () => {
    recordGroundingReceipt("r8", "github__read_file");
    const r = groundingReceipts("r8");
    expect(r.has("repo_read")).toBe(true);
    expect(r.size).toBe(1);
  });

  it("repo_history is unaffected by provenance", () => {
    recordGroundingReceipt("r9", "github__list_commits", true, "doc");
    const r = groundingReceipts("r9");
    expect(r.has("repo_history")).toBe(true);
    expect(r.has("repo_doc_read")).toBe(false);
  });
});

