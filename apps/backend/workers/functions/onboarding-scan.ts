
import { inngest } from "../client";
import { runWebsiteScan, scanSpendAllowed } from "@/services/onboarding/scan";
import { finishScan, markScanFailed, startScan } from "@/services/onboarding/scan-store";
import { withVendorContext } from "@/services/vendors/usage";

const FINISHED = "onboarding/scan.finished" as const;

export const onboardingScanFn = inngest.createFunction(
  {
    id: "onboarding-scan",
    retries: 1,
    idempotency: "event.data.scan_id",
    concurrency: { key: "event.data.scan_id", limit: 1 },
    onFailure: async ({ event, error }) => {
      const scanId = (event.data.event.data as { scan_id?: string }).scan_id;
      if (typeof scanId !== "string" || !scanId) return;
      console.error(`[onboarding-scan] failed: ${error?.message?.slice(0, 200)}`);
      await markScanFailed(scanId).catch(() => undefined);
      await inngest.send({ name: FINISHED, data: { scan_id: scanId } }).catch(() => undefined);
    },
  },
  { event: "onboarding/scan.requested" },
  async ({ event, step }) => {
    const scanId = event.data.scan_id;
    if (typeof scanId !== "string" || !scanId) return { status: "skip", reason: "no_scan_id" };

    const scan = await step.run("load", () => startScan(scanId));
    if (!scan) return { status: "skip", reason: "not_runnable" };

    const spend = await step.run("spend-allowed", () => scanSpendAllowed());
    if (!spend.ok) {
      await step.run("skip", () => finishScan(scanId, { status: "skipped", reason: spend.reason }));
      await step.sendEvent("finished-skipped", { name: FINISHED, data: { scan_id: scanId } });
      return { status: "done", skipped: spend.reason };
    }

    const outcome = await step.run("scan", async () => {
      const enrichment = await withVendorContext({ tenant_id: null, source: "onboarding" }, () =>
        runWebsiteScan(scan.host, null),
      );
      await finishScan(scanId, enrichment);
      return enrichment.status;
    });
    await step.sendEvent("finished", { name: FINISHED, data: { scan_id: scanId } });
    return { status: "done", enrichment: outcome };
  },
);
