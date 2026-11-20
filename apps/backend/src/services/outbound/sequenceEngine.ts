
import {
  enforceCommsSafety,
  type CommsSafetyStore,
} from "@/services/comms/safety-net";
import {
  claimDueProspects,
  advanceProspect,
  stopProspect,
  type OutboundProspect,
} from "./prospectStore";

export interface OutboundSendProposal {
  decision_class: "outbound.send";
  tenant_id: string;
  prospect_id: string;
  channel: string;
  handle: string;
  step: number;
}

export interface SequenceTickResult {
  claimed: number;
  proposed: OutboundSendProposal[];
  advanced: number;
  stopped: number;
  skipped: Array<{ prospectId: string; reason: string }>;
}

export type ProposeSendFn = (p: OutboundSendProposal) => Promise<void>;

export interface TickDeps {
  proposeSend: ProposeSendFn;
  safetyStore?: CommsSafetyStore;
  limit?: number;
}

export async function runSequenceTick(
  deps: TickDeps,
): Promise<SequenceTickResult> {
  const due: OutboundProspect[] = await claimDueProspects(deps.limit ?? 100);

  const result: SequenceTickResult = {
    claimed: due.length,
    proposed: [],
    advanced: 0,
    stopped: 0,
    skipped: [],
  };

  for (const p of due) {
    const decision = await enforceCommsSafety(
      { tenant_id: p.tenant_id, channel: p.channel, recipient: p.handle.trim().toLowerCase() },
      deps.safetyStore,
    );

    if (!decision.allowed) {
      if (decision.reason === "unsubscribed" || decision.reason === "suppressed") {
        await stopProspect(
          p.tenant_id,
          p.id,
          decision.reason === "unsubscribed" ? "unsubscribed" : "manual",
        );
        result.stopped += 1;
      } else {
        result.skipped.push({ prospectId: p.id, reason: decision.reason });
      }
      continue;
    }

    const proposal: OutboundSendProposal = {
      decision_class: "outbound.send",
      tenant_id: p.tenant_id,
      prospect_id: p.id,
      channel: p.channel,
      handle: p.handle,
      step: p.sequence_step,
    };
    await deps.proposeSend(proposal);
    result.proposed.push(proposal);

    const adv = await advanceProspect(p.tenant_id, p.id);
    if (adv.ok) {
      result.advanced += 1;
    } else {
      result.skipped.push({ prospectId: p.id, reason: adv.reason ?? "advance_failed" });
    }
  }

  return result;
}
