"use client";

import { agentDisplayName } from "@/lib/agentRegistry";

export type DispatchProposal = {
  agent_slug: string;
  brief: string;
  why: string;
};

export function ProposalCard({ proposal }: { proposal: DispatchProposal }) {
  return (
    <div className="rounded-lg border border-ink/10 bg-white/70 p-3.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-mono uppercase tracking-[0.14em] text-inkMuted">
          Dispatch proposal
        </span>
        <span className="text-inkMuted">·</span>
        <span className="text-[13px] font-semibold text-ink">
          {agentDisplayName(proposal.agent_slug)}
        </span>
      </div>
      <p className="mb-1.5 text-[13px] leading-[1.6] text-ink">
        <span className="font-medium">Brief:</span> {proposal.brief}
      </p>
      <p className="text-[12px] leading-[1.55] text-inkMuted">
        <span className="font-medium">Why:</span> {proposal.why}
      </p>
    </div>
  );
}
