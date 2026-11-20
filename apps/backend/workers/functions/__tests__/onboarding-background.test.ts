
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: ReturnType<typeof fakeStep> }) => Promise<unknown>;
type Captured = { opts: Record<string, unknown>; handler: Handler };
const created: Record<string, Captured> = {};
const clientSend = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../../client", () => ({
  inngest: {
    createFunction: (opts: Record<string, unknown>, _trigger: unknown, handler: Handler) => {
      created[String(opts.id)] = { opts, handler };
      return { opts };
    },
    send: (...a: unknown[]) => clientSend(...a),
  },
}));

const job = {
  loadJob: vi.fn(),
  scanStatus: vi.fn(),
  scanSpendAllowed: vi.fn(),
  inlineScan: vi.fn(),
  applyScan: vi.fn(async () => ({ name_updated: false, shape: null })),
  generateForJob: vi.fn(async () => ({ company: "# C", ops: "# O", fallback: false })),
  writeMemory: vi.fn(async () => ({ company_stored: true, ops_written: true })),
  finishJob: vi.fn(async () => undefined),
  failJob: vi.fn(async () => ({ marked: true })),
};
vi.mock("@/services/onboarding/website-memory-job", () => job);

const scanSvc = { runWebsiteScan: vi.fn(), scanSpendAllowed: vi.fn() };
vi.mock("@/services/onboarding/scan", () => scanSvc);
const store = { startScan: vi.fn(), finishScan: vi.fn(async () => undefined), markScanFailed: vi.fn(async () => undefined) };
vi.mock("@/services/onboarding/scan-store", () => store);

function fakeStep() {
  const ids: string[] = [];
  return {
    ids,
    run: vi.fn(async (id: string, fn: () => unknown) => {
      ids.push(id);
      return fn();
    }),
    waitForEvent: vi.fn(async (id: string, _o: unknown) => {
      ids.push(id);
      return null;
    }),
    sendEvent: vi.fn(async (id: string, _e: unknown) => {
      ids.push(id);
    }),
  };
}

let memoryFn: Captured;
let scanFn: Captured;
beforeAll(async () => {
  await import("../onboarding-website-memory");
  await import("../onboarding-scan");
  memoryFn = created["onboarding-website-memory"];
  scanFn = created["onboarding-scan"];
});

const SCAN = "AbCdEfGhIjKlMnOp12";
const row = (over: Record<string, unknown> = {}) => ({
  tenant_id: "t1", user_id: "u1", host: "acme.com", initial_name: "Acme", scan_public_id: null, status: "pending", attempt: 0, ...over,
});

beforeEach(() => {
  for (const f of Object.values(job)) f.mockClear();
  for (const f of [...Object.values(scanSvc), ...Object.values(store)]) f.mockClear();
  clientSend.mockClear();
});

describe("onboarding-website-memory", () => {
  it("is keyed and serialised per tenant + attempt, with 2 retries", () => {
    expect(memoryFn.opts).toMatchObject({
      retries: 2,
      idempotency: "event.data.tenant_id + ':' + string(event.data.attempt)",
      concurrency: { key: "event.data.tenant_id", limit: 1 },
    });
  });

  it("attempt 0 without a scan never scans: memory from the address only", async () => {
    job.loadJob.mockResolvedValueOnce({ ok: true, row: row() });
    const step = fakeStep();
    await memoryFn.handler({ event: { data: { tenant_id: "t1", attempt: 0 } }, step });
    expect(job.scanSpendAllowed).not.toHaveBeenCalled();
    expect(job.inlineScan).not.toHaveBeenCalled();
    expect(job.applyScan).toHaveBeenCalledWith(row(), null);
    expect(job.generateForJob).toHaveBeenCalledWith(row(), null);
    expect(job.writeMemory).toHaveBeenCalledWith("t1", { company: "# C", ops: "# O", fallback: false });
    expect(job.finishJob).toHaveBeenCalledWith("t1", expect.objectContaining({ fallback: false, scan_status: "none" }));
    expect(new Set(step.ids).size).toBe(step.ids.length);
  });

  it("a running scan: look, wait for THAT scan's finished event, look again", async () => {
    const r = row({ scan_public_id: SCAN });
    job.loadJob.mockResolvedValueOnce({ ok: true, row: r });
    job.scanStatus.mockResolvedValueOnce("running").mockResolvedValueOnce("done");
    const step = fakeStep();
    await memoryFn.handler({ event: { data: { tenant_id: "t1", attempt: 0 } }, step });
    expect(step.waitForEvent).toHaveBeenCalledWith("scan-wait", {
      event: "onboarding/scan.finished",
      timeout: "150s",
      if: `async.data.scan_id == '${SCAN}'`,
    });
    expect(step.ids).toEqual(["load", "scan-0", "scan-wait", "scan-1", "apply-scan", "generate", "write", "ready"]);
    expect(job.applyScan).toHaveBeenCalledWith(r, SCAN);
  });

  it("a scan that failed or is not this user's is not used", async () => {
    const r = row({ scan_public_id: SCAN });
    job.loadJob.mockResolvedValueOnce({ ok: true, row: r });
    job.scanStatus.mockResolvedValueOnce("missing");
    const step = fakeStep();
    await memoryFn.handler({ event: { data: { tenant_id: "t1", attempt: 0 } }, step });
    expect(step.waitForEvent).not.toHaveBeenCalled();
    expect(job.generateForJob).toHaveBeenCalledWith(r, null);
  });

  it("Retry (attempt > 0, no scan) re-checks spend, then scans inline", async () => {
    const r = row({ attempt: 1 });
    job.loadJob.mockResolvedValueOnce({ ok: true, row: r });
    job.scanSpendAllowed.mockResolvedValueOnce({ ok: true });
    job.inlineScan.mockResolvedValueOnce(SCAN);
    const step = fakeStep();
    await memoryFn.handler({ event: { data: { tenant_id: "t1", attempt: 1 } }, step });
    expect(step.ids.slice(0, 3)).toEqual(["load", "spend-allowed", "inline-scan"]);
    expect(job.generateForJob).toHaveBeenCalledWith(r, SCAN);
  });

  it("Retry with spend switched off writes from the address without scanning", async () => {
    job.loadJob.mockResolvedValueOnce({ ok: true, row: row({ attempt: 1 }) });
    job.scanSpendAllowed.mockResolvedValueOnce({ ok: false, reason: "enrichment_disabled" });
    await memoryFn.handler({ event: { data: { tenant_id: "t1", attempt: 1 } }, step: fakeStep() });
    expect(job.inlineScan).not.toHaveBeenCalled();
    expect(job.finishJob).toHaveBeenCalledWith("t1", expect.objectContaining({ scan_status: "enrichment_disabled" }));
  });

  it("stops when the row is not pending or the user is no longer a member", async () => {
    job.loadJob.mockResolvedValueOnce({ ok: false, reason: "not_member" });
    const out = await memoryFn.handler({ event: { data: { tenant_id: "t1", attempt: 0 } }, step: fakeStep() });
    expect(out).toEqual({ status: "skip", reason: "not_member" });
    expect(job.generateForJob).not.toHaveBeenCalled();
    expect(job.writeMemory).not.toHaveBeenCalled();
  });

  it("onFailure marks the tenant's row failed (the job re-checks the row itself)", async () => {
    const onFailure = memoryFn.opts.onFailure as (ctx: unknown) => Promise<void>;
    await onFailure({ event: { data: { event: { data: { tenant_id: "t1", attempt: 0 } } } }, error: new Error("model down") });
    expect(job.failJob).toHaveBeenCalledWith("t1", "model down");
  });
});

describe("onboarding-scan", () => {
  it("re-checks the spend switches at execution time and never crawls when off", async () => {
    store.startScan.mockResolvedValueOnce({ host: "acme.com" });
    scanSvc.scanSpendAllowed.mockResolvedValueOnce({ ok: false, reason: "enrichment_disabled" });
    const step = fakeStep();
    await scanFn.handler({ event: { data: { scan_id: SCAN } }, step });
    expect(scanSvc.runWebsiteScan).not.toHaveBeenCalled();
    expect(store.finishScan).toHaveBeenCalledWith(SCAN, { status: "skipped", reason: "enrichment_disabled" });
    expect(step.sendEvent).toHaveBeenCalledWith("finished-skipped", { name: "onboarding/scan.finished", data: { scan_id: SCAN } });
  });

  it("scans, stores + finishes in the same step, then tells the memory job", async () => {
    store.startScan.mockResolvedValueOnce({ host: "acme.com" });
    scanSvc.scanSpendAllowed.mockResolvedValueOnce({ ok: true });
    scanSvc.runWebsiteScan.mockResolvedValueOnce({ status: "ok", domain_pages: [], app_listings: [], research_pages: [] });
    const step = fakeStep();
    await scanFn.handler({ event: { data: { scan_id: SCAN } }, step });
    expect(scanSvc.runWebsiteScan).toHaveBeenCalledWith("acme.com", null);
    expect(store.finishScan).toHaveBeenCalledWith(SCAN, expect.objectContaining({ status: "ok" }));
    expect(step.ids).toEqual(["load", "spend-allowed", "scan", "finished"]);
  });

  it("a finished / expired / unknown scan is not re-run", async () => {
    store.startScan.mockResolvedValueOnce(null);
    await scanFn.handler({ event: { data: { scan_id: SCAN } }, step: fakeStep() });
    expect(scanSvc.scanSpendAllowed).not.toHaveBeenCalled();
    expect(scanSvc.runWebsiteScan).not.toHaveBeenCalled();
  });

  it("onFailure marks the scan failed and still releases the waiting memory job", async () => {
    const onFailure = scanFn.opts.onFailure as (ctx: unknown) => Promise<void>;
    await onFailure({ event: { data: { event: { data: { scan_id: SCAN } } } }, error: new Error("boom") });
    expect(store.markScanFailed).toHaveBeenCalledWith(SCAN);
    expect(clientSend).toHaveBeenCalledWith({ name: "onboarding/scan.finished", data: { scan_id: SCAN } });
  });
});
