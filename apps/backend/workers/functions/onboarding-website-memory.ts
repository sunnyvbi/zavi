
import { inngest } from "../client";
import {
  applyScan,
  failJob,
  finishJob,
  generateForJob,
  inlineScan,
  loadJob,
  scanSpendAllowed,
  scanStatus,
  writeMemory,
} from "@/services/onboarding/website-memory-job";

const SCAN_ID = /^[A-Za-z0-9]{16,32}$/;

export const onboardingWebsiteMemoryFn = inngest.createFunction(
  {
    id: "onboarding-website-memory",
    retries: 2,
    idempotency: "event.data.tenant_id + ':' + string(event.data.attempt)",
    concurrency: { key: "event.data.tenant_id", limit: 1 },
    onFailure: async ({ event, error }) => {
      const tenantId = (event.data.event.data as { tenant_id?: string }).tenant_id;
      if (typeof tenantId !== "string" || !tenantId) return;
      const msg = error?.message?.slice(0, 500) || "memory job failed";
      await failJob(tenantId, msg).catch((e: Error) =>
        console.warn(`[onboarding-website-memory] fail-mark failed: ${e.message?.slice(0, 200)}`),
      );
    },
  },
  { event: "tenant/onboarding.memory.requested" },
  async ({ event, step }) => {
    const startedAt = Date.now();
    const tenantId = event.data.tenant_id;
    if (typeof tenantId !== "string" || !tenantId) return { status: "skip", reason: "no_tenant_id" };

    const loaded = await step.run("load", () => loadJob(tenantId));
    if (!loaded.ok) return { status: "skip", reason: loaded.reason };
    const row = loaded.row;

    let scanId: string | null = row.scan_public_id && SCAN_ID.test(row.scan_public_id) ? row.scan_public_id : null;
    let scanState = "none";
    if (scanId) {
      const id = scanId;
      scanState = await step.run("scan-0", () => scanStatus(id, row.user_id));
      if (scanState === "queued" || scanState === "running") {
        await step.waitForEvent("scan-wait", {
          event: "onboarding/scan.finished",
          timeout: "150s",
          if: `async.data.scan_id == '${id}'`,
        });
        scanState = await step.run("scan-1", () => scanStatus(id, row.user_id));
      }
    } else if (row.attempt > 0 && row.host) {
      const spend = await step.run("spend-allowed", () => scanSpendAllowed());
      if (spend.ok) {
        scanId = await step.run("inline-scan", () => inlineScan(row));
        scanState = scanId ? "done" : "none";
      } else {
        scanState = spend.reason;
      }
    }
    const usableScan = scanState === "done" ? scanId : null;

    await step.run("apply-scan", () => applyScan(row, usableScan));
    const memory = await step.run("generate", () => generateForJob(row, usableScan));
    await step.run("write", () => writeMemory(tenantId, memory));
    await step.run("ready", () =>
      finishJob(tenantId, { fallback: memory.fallback, scan_status: scanState, ms: Date.now() - startedAt }),
    );
    return { status: "ready", fallback: memory.fallback, scan: scanState };
  },
);
