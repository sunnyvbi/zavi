
import { inngest } from "../client";
import { enqueueWorkItem } from "@/services/agents/work-queue";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import {
  runSequenceTick,
  type OutboundSendProposal,
} from "@/services/outbound/sequenceEngine";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";

async function proposeSend(p: OutboundSendProposal): Promise<void> {
  await enqueueWorkItem({
    tenant_id: p.tenant_id,
    agent_slug: "outbound-sdr",
    source: "cron",
    dedupe_key: `outbound-seq:${p.tenant_id}:${p.prospect_id}:${p.step}`,
    payload: {
      reason: `outbound sequence step ${p.step}`,
      outbound_sequence: {
        prospect_id: p.prospect_id,
        channel: p.channel,
        handle: p.handle,
        step: p.step,
      },
    },
  });
}

export async function runOutboundSequenceTick() {
  if (await isFleetHalted()) {
    return { claimed: 0, proposed: [], advanced: 0, stopped: 0, skipped: [], halted: true };
  }
  return runSequenceTick({ proposeSend });
}

export const outboundSequenceTickFn = inngest.createFunction(
  { id: "outbound-sequence-tick", retries: 2 },
  { cron: "0 * * * *" },
  async () => {
    if (isWorkerCronStopped("outbound-sequence-tick")) {
      return { cron_stopped: true as const };
    }
    return runOutboundSequenceTick();
  },
);
