
import type { ToolCallTrace } from "@/services/tools/types";

export type EntityAtom = {
  kind: "pr" | "commit" | "file";
  ref: string;
  claimTerms: string[];
};

export type EntityGroundingVerdict = {
  hasEntityClaim: boolean;
  grounded: boolean;
  contradicted: boolean;
  atoms: EntityAtom[];
  groundedBy: { tool: string; ref: string } | null;
  reason: string;
};

const PR_RE = /\bPR\s*#?(\d{2,6})\b|\b#(\d{2,6})\b/gi;
const COMMIT_RE = /\b(?:commit\s+)?([0-9a-f]{7,40})\b/gi;
const FILE_RE = /\b([\w./-]+\.(?:ts|tsx|js|jsx|sql|py|go|rb|md|json|yml|yaml))\b/gi;

const CAUSAL_ACTION_RE =
  /\b(?:fix(?:es|ed)?|caus(?:es|ed)|root cause|resolv(?:es|ed)|merge[ds]?|deploy(?:s|ed)?|ship(?:s|ped)?|refund(?:s|ed)?|unmerged|blocks?|blocking|urgent|responsible for|is the fix|introduc(?:es|ed))\b/i;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "to",
  "of", "in", "on", "for", "with", "that", "this", "it", "its", "as", "at", "by",
  "fixes", "fixed", "fix", "merge", "deploy", "urgent", "unmerged", "blocks",
  "still", "open", "pr", "commit", "branch", "file", "causes", "caused", "race",
]);

function significantTerms(text: string): string[] {
  return Array.from(
    new Set(
      (text.toLowerCase().match(/[a-z][a-z0-9_.-]{3,}/g) || []).filter(
        (w) => !STOPWORDS.has(w),
      ),
    ),
  );
}

function sentenceAround(body: string, idx: number): string {
  const start = Math.max(0, body.lastIndexOf(".", idx) + 1);
  let end = body.indexOf(".", idx);
  if (end === -1) end = body.length;
  return body.slice(start, end).trim();
}

export function extractEntityAtoms(body: string): EntityAtom[] {
  const atoms: EntityAtom[] = [];
  const seen = new Set<string>();
  const pushIf = (kind: EntityAtom["kind"], ref: string, idx: number) => {
    const sentence = sentenceAround(body, idx);
    if (!CAUSAL_ACTION_RE.test(sentence)) return;
    const key = `${kind}:${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    atoms.push({ kind, ref, claimTerms: significantTerms(sentence) });
  };
  for (const m of body.matchAll(PR_RE)) pushIf("pr", (m[1] || m[2]) as string, m.index ?? 0);
  for (const m of body.matchAll(COMMIT_RE)) {
    const ref = m[1];
    if (/[a-f]/i.test(ref)) pushIf("commit", ref.toLowerCase(), m.index ?? 0);
  }
  for (const m of body.matchAll(FILE_RE)) pushIf("file", m[1], m.index ?? 0);
  return atoms;
}

function reconcileAtom(
  atom: EntityAtom,
  toolCalls: ToolCallTrace[],
): { grounded: boolean; contradicted: boolean; tool?: string } {
  const refNeedle = atom.ref.toLowerCase();
  let sawReference = false;
  let sawSupport = false;
  let supportingTool: string | undefined;
  for (const tc of toolCalls) {
    if (tc.status !== "ok") continue;
    const out = (tc.output_preview || "").toLowerCase();
    if (!out) continue;
    const referencesEntity =
      out.includes(`#${refNeedle}`) ||
      out.includes(`pr ${refNeedle}`) ||
      out.includes(refNeedle);
    if (!referencesEntity) continue;
    sawReference = true;
    const outTerms = new Set(significantTerms(out));
    const overlap = atom.claimTerms.some((t) => outTerms.has(t));
    if (overlap) {
      sawSupport = true;
      supportingTool = tc.name;
      break;
    }
  }
  if (sawSupport) return { grounded: true, contradicted: false, tool: supportingTool };
  if (sawReference) return { grounded: false, contradicted: true };
  return { grounded: false, contradicted: false };
}

export function classifyEntityGrounding(args: {
  body: string;
  toolCalls: ToolCallTrace[];
}): EntityGroundingVerdict {
  const atoms = extractEntityAtoms(args.body || "");
  if (atoms.length === 0) {
    return {
      hasEntityClaim: false,
      grounded: false,
      contradicted: false,
      atoms,
      groundedBy: null,
      reason: "no named-entity/causal claim — gate inert",
    };
  }
  let anyGrounded = false;
  let anyContradicted = false;
  let groundedBy: EntityGroundingVerdict["groundedBy"] = null;
  for (const atom of atoms) {
    const r = reconcileAtom(atom, args.toolCalls || []);
    if (r.contradicted) anyContradicted = true;
    if (r.grounded && !groundedBy) {
      anyGrounded = true;
      groundedBy = { tool: r.tool as string, ref: atom.ref };
    } else if (r.grounded) {
      anyGrounded = true;
    }
  }
  const grounded = anyGrounded && !anyContradicted;
  const reason = anyContradicted
    ? "entity claim CONTRADICTED by a this-run tool return (existence != relationship)"
    : grounded
      ? `entity claim grounded by ${groundedBy?.tool}`
      : "entity/causal claim not grounded by any this-run tool return";
  return {
    hasEntityClaim: true,
    grounded,
    contradicted: anyContradicted,
    atoms,
    groundedBy: grounded ? groundedBy : null,
    reason,
  };
}
