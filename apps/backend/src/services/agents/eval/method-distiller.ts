
import { scoreAtoms, type AtomScore } from "./atom-scorer";
import {
  scanForTenantContamination,
  type ScanResult,
} from "./method-contamination-scanner";

export interface DistillerRun {
  run_id: string;
  tenant_id: string;
  agent_slug: string;
  output_text: string;
  tool_calls: unknown[];
  decision_body?: unknown;
  created_at?: string;
}

export interface RankedRun {
  run: DistillerRun;
  score: AtomScore;
}

export interface MethodPattern {
  id: string;
  text: string;
  supportedByRunIds: string[];
}

export interface MethodBlockProposal {
  agentSlug: string;
  block: string;
  patterns: MethodPattern[];
  fromRunIds: string[];
  scan: ScanResult;
  accepted: boolean;
  rejectedReason?: string;
}

interface PatternDetector {
  id: string;
  detect: (ranked: RankedRun[]) => boolean;
  text: string;
}

function usedToolsBeforeAsserting(ranked: RankedRun[]): boolean {
  const withNumberAtoms = ranked.filter((r) =>
    r.score.atoms.some((a) => a.kind === "number"),
  );
  if (withNumberAtoms.length === 0) return false;
  const grounded = withNumberAtoms.filter(
    (r) =>
      r.score.atoms.filter((a) => a.kind === "number" && a.verdict === "pass")
        .length >=
      r.score.atoms.filter((a) => a.kind === "number").length / 2,
  );
  return grounded.length >= Math.ceil(withNumberAtoms.length / 2);
}

function calledLiveTools(ranked: RankedRun[]): boolean {
  return ranked.some((r) =>
    (Array.isArray(r.run.tool_calls) ? r.run.tool_calls : []).some(
      (t) =>
        t != null &&
        typeof (t as { name?: unknown }).name === "string" &&
        !(t as { name: string }).name.startsWith("memory__"),
    ),
  );
}

function keptCoverageHigh(ranked: RankedRun[]): boolean {
  if (ranked.length === 0) return false;
  const avg =
    ranked.reduce((s, r) => s + r.score.coverage, 0) / ranked.length;
  return avg >= 0.4;
}

const METHOD_DETECTORS: PatternDetector[] = [
  {
    id: "ground-numbers-in-tools",
    detect: usedToolsBeforeAsserting,
    text: "Ground every number you state in a tool result from THIS run — pull the figure from a live read/list call before asserting it, and cite the tool that returned it. Never state a metric, count, or amount you did not just observe.",
  },
  {
    id: "read-before-act",
    detect: calledLiveTools,
    text: "Investigate with your read tools before drawing a conclusion — diagnose first, then act. A recommendation built on a fresh tool read beats one built on memory or assumption.",
  },
  {
    id: "keep-claims-verifiable",
    detect: keptCoverageHigh,
    text: "Prefer concrete, checkable statements over unverifiable prose — every claim should be one a reader could confirm against the evidence you gathered.",
  },
];

const TWO_MODE_AGENTS = new Set(["growth-lead"]);
const TWO_MODE_PRESERVATION_NOTE =
  "Preserve your two modes: in a conversation reply in tight customer-facing PROSE (lead with the recommendation, no digest envelope); on a scheduled run emit the STRUCTURED digest envelope. The method notes below refine HOW you work within each mode — they never merge the two.";

export function rankRunsByAtomScore(runs: DistillerRun[]): RankedRun[] {
  const ranked: RankedRun[] = runs.map((run) => ({
    run,
    score: scoreAtoms({
      outputText: run.output_text,
      toolCalls: run.tool_calls,
      decisionBody: run.decision_body,
    }),
  }));
  ranked.sort((a, b) => {
    if (b.score.grade !== a.score.grade) return b.score.grade - a.score.grade;
    const at = a.run.created_at ?? "";
    const bt = b.run.created_at ?? "";
    return bt.localeCompare(at);
  });
  return ranked;
}

export function proposeMethodBlock(args: {
  agentSlug: string;
  runs: DistillerRun[];
  topN?: number;
  tenantTokens?: string[];
}): MethodBlockProposal {
  const topN = args.topN ?? 5;
  const ranked = rankRunsByAtomScore(args.runs).slice(0, Math.max(1, topN));
  const fromRunIds = ranked.map((r) => r.run.run_id);

  const patterns: MethodPattern[] = [];
  for (const det of METHOD_DETECTORS) {
    if (!det.detect(ranked)) continue;
    patterns.push({
      id: det.id,
      text: det.text,
      supportedByRunIds: fromRunIds,
    });
  }

  const isTwoMode = TWO_MODE_AGENTS.has(args.agentSlug);
  const blockLines: string[] = ["## Method (distilled)"];
  blockLines.push(
    "<!-- Auto-distilled from this agent's own best verified runs (①C atom-score). " +
      "METHOD patterns only — never tenant facts. Human review required before merge. -->",
  );
  if (isTwoMode) blockLines.push("", `- ${TWO_MODE_PRESERVATION_NOTE}`);
  for (const p of patterns) blockLines.push(`- ${p.text}`);
  const block = blockLines.join("\n");

  const scan = scanForTenantContamination(block, {
    tenantTokens: args.tenantTokens,
  });

  let accepted = scan.clean && patterns.length > 0;
  let rejectedReason: string | undefined;
  if (!scan.clean) {
    accepted = false;
    rejectedReason = `contamination: ${scan.hits
      .map((h) => `${h.kind}(${h.match})`)
      .join(", ")}`;
  } else if (patterns.length === 0) {
    accepted = false;
    rejectedReason = "no method pattern detected in best runs";
  }

  return {
    agentSlug: args.agentSlug,
    block,
    patterns,
    fromRunIds,
    scan,
    accepted,
    rejectedReason,
  };
}

export function proposeMethodBlocks(args: {
  runs: DistillerRun[];
  topN?: number;
  tenantTokensByTenant?: Record<string, string[]>;
}): MethodBlockProposal[] {
  const byAgent = new Map<string, DistillerRun[]>();
  for (const run of args.runs) {
    const list = byAgent.get(run.agent_slug) ?? [];
    list.push(run);
    byAgent.set(run.agent_slug, list);
  }

  const tokenMap = args.tenantTokensByTenant ?? {};
  const proposals: MethodBlockProposal[] = [];
  for (const [agentSlug, runs] of byAgent) {
    const tenantTokens = Array.from(
      new Set(
        runs.flatMap((r) => tokenMap[r.tenant_id] ?? []).filter(Boolean),
      ),
    );
    proposals.push(
      proposeMethodBlock({ agentSlug, runs, topN: args.topN, tenantTokens }),
    );
  }
  return proposals.sort((a, b) => a.agentSlug.localeCompare(b.agentSlug));
}

export function renderProposalReport(
  proposals: MethodBlockProposal[],
): string {
  const lines: string[] = [
    "# ③A distilled method blocks — PROPOSED (human review before any agent.md write)",
    "",
    "> Auto-generated by method-distiller (D5). METHOD patterns only — tenant facts are",
    "> blocked by the contamination scanner. Review brand/design voice, then apply ACCEPTED",
    "> blocks manually. Do NOT machine-apply.",
    "",
  ];
  const accepted = proposals.filter((p) => p.accepted);
  const rejected = proposals.filter((p) => !p.accepted);

  lines.push(`## Accepted (${accepted.length})`, "");
  for (const p of accepted) {
    lines.push(
      `### ${p.agentSlug}`,
      `_distilled from runs: ${p.fromRunIds.join(", ") || "—"}_`,
      "",
      "```markdown",
      p.block,
      "```",
      "",
    );
  }

  lines.push(`## Rejected (${rejected.length})`, "");
  for (const p of rejected) {
    lines.push(
      `### ${p.agentSlug}`,
      `- reason: ${p.rejectedReason ?? "unknown"}`,
      ...(p.scan.hits.length
        ? [
            `- contamination hits: ${p.scan.hits
              .map((h) => `${h.kind}=\`${h.match}\``)
              .join(", ")}`,
          ]
        : []),
      "",
    );
  }
  return lines.join("\n");
}
