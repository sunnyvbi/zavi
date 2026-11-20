
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dispatcherSrc = readFileSync(
  join(__dirname, "../generic-dispatcher.ts"),
  "utf-8",
);

describe("generic-dispatcher — identity blocks load concurrently", () => {
  it("fans the four identity builders out through Promise.allSettled", () => {
    expect(dispatcherSrc).toMatch(
      /Promise\.allSettled\(\[[\s\S]{0,2000}?buildCompanyFactSheet\([\s\S]{0,2000}?buildPersonalizationBlock\([\s\S]{0,600}?buildInboxAddressBlock\([\s\S]{0,600}?buildGrowthStrategyBlock\(/,
    );
  });

  it("never awaits an identity builder on its own line again", () => {
    for (const builder of [
      "buildCompanyFactSheet",
      "buildPersonalizationBlock",
      "buildInboxAddressBlock",
      "buildGrowthStrategyBlock",
    ]) {
      expect(dispatcherSrc, builder).not.toMatch(
        new RegExp(`(const|let)\\s+\\w+\\s*=\\s*await\\s+${builder}\\(`),
      );
    }
  });

  it("still marks identity_blocks after the fan-out, so run_timing stays comparable", () => {
    expect(dispatcherSrc).toMatch(
      /growthR\.status === "fulfilled"[\s\S]{0,200}?markRunTiming\(ctx\.runId, "identity_blocks"\)/,
    );
  });

  it("treats a rejected identity block as absent, like its own soft-fail does", () => {
    for (const result of ["factSheetR", "personalizationR", "inboxR", "growthR"]) {
      expect(dispatcherSrc, result).toMatch(
        new RegExp(`${result}\\.status === "fulfilled" \\? ${result}\\.value : undefined`),
      );
    }
  });
});

describe("generic-dispatcher — memory recall and connector read load concurrently", () => {
  it("fans memory_recall and live_connectors out through one Promise.allSettled", () => {
    expect(dispatcherSrc).toMatch(
      /Promise\.allSettled\(\[[\s\S]{0,2500}?withTimeout\("memory_recall", MEMORY_RECALL_BUDGET_MS[\s\S]{0,2500}?withTimeout\("live_connectors", 2000/,
    );
  });

  it("keeps the recall budget larger than the rerank STAGE it has to contain", () => {
    const m = dispatcherSrc.match(
      /const MEMORY_RECALL_BUDGET_MS = RERANK_STAGE_MS \+ (\d+);/,
    );
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(2000);
    expect(dispatcherSrc).toMatch(/deadline_at: Date\.now\(\) \+ MEMORY_RECALL_BUDGET_MS/);
    expect(dispatcherSrc).toMatch(/withTimeout\("live_connectors", 2000/);
  });

  it("keeps the two degraded paths separately diagnosable", () => {
    expect(dispatcherSrc).toMatch(/stage: "search"/);
    expect(dispatcherSrc).toMatch(/stage: "connectors"/);
    expect(dispatcherSrc).toMatch(
      /hitsResult\.status === "fulfilled"[\s\S]{0,700}?stage: "search"/,
    );
    expect(dispatcherSrc).toMatch(
      /memConnectorsResult\.status === "fulfilled"[\s\S]{0,700}?stage: "connectors"/,
    );
  });

  it("carries the do-not-simplify warning for the next reader", () => {
    expect(dispatcherSrc).toMatch(/unhandledRejection guard/);
  });
});

describe("concurrent-read degrade contract", () => {
  const slowOk = <T>(value: T, ms: number) =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
  const failsFast = (ms: number) =>
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));

  it("degrades the failed read and keeps the healthy one, unwrapped in order", async () => {
    const [firstR, secondR] = await Promise.allSettled([
      slowOk(["hit"], 30),
      failsFast(1),
    ]);

    const hits = firstR.status === "fulfilled" ? firstR.value : [];
    const connectors = secondR.status === "fulfilled" ? secondR.value : [];

    expect(hits).toEqual(["hit"]);
    expect(connectors).toEqual([]);
  });

  it("does not surface an unhandled rejection when a read fails first", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const results = await Promise.allSettled([slowOk("late", 40), failsFast(1)]);
      await new Promise((r) => setTimeout(r, 60));
      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("rejected");
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("costs the MAX of the two reads, not the SUM", async () => {
    const started = Date.now();
    await Promise.allSettled([slowOk(1, 60), slowOk(2, 60)]);
    expect(Date.now() - started).toBeLessThan(110);
  });
});
