
import type { ToolCallTrace } from "@/services/tools/types";
import { amountInToolOutputs } from "../cap-grounding-verifier";

export type AtomKind = "number" | "url" | "claim";
export type AtomVerdict = "pass" | "fail" | "unverifiable";

export interface Atom {
  text: string;
  kind: AtomKind;
  verdict: AtomVerdict;
  evidence?: string;
}

export interface AtomScore {
  atoms: Atom[];
  surviving: number;
  total: number;
  coverage: number;
  grade: number;
}

const DOLLAR_TOKEN = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/g;

const URL_TOKEN = /https?:\/\/[^\s<>")']+/gi;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?:])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeAmount(raw: string): string {
  const cleaned = raw.replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return cleaned;
  return String(n);
}

function isSubstantiveSentence(sentence: string): boolean {
  const words = sentence.match(/[A-Za-z]{2,}/g);
  return !!words && words.length >= 3;
}

export function scoreAtoms(args: {
  outputText: string;
  toolCalls: unknown[];
  decisionBody?: unknown;
  evalUrlEntailment?: boolean;
}): AtomScore {
  const text = typeof args.outputText === "string" ? args.outputText : "";
  const toolCalls = (Array.isArray(args.toolCalls)
    ? args.toolCalls
    : []) as readonly ToolCallTrace[];

  const atoms: Atom[] = [];

  if (text.length === 0) {
    return { atoms, surviving: 0, total: 0, coverage: 0, grade: 0 };
  }

  for (const sentence of splitSentences(text)) {
    let emittedVerifiableAtom = false;

    const dollarTokens = sentence.match(DOLLAR_TOKEN);
    if (dollarTokens) {
      for (const tok of dollarTokens) {
        const amount = normalizeAmount(tok);
        const grounded = amountInToolOutputs(amount, toolCalls);
        atoms.push({
          text: tok.trim(),
          kind: "number",
          verdict: grounded ? "pass" : "fail",
          evidence: grounded
            ? "money value found in a tool output this run"
            : "no tool output this run contains this money value",
        });
        emittedVerifiableAtom = true;
      }
    }

    const urlTokens = sentence.match(URL_TOKEN);
    if (urlTokens) {
      for (const u of urlTokens) {
        atoms.push({
          text: u,
          kind: "url",
          verdict: "unverifiable",
          evidence: "url entailment is Tier-2 (eval-only); not checked in Tier-1",
        });
      }
    }

    if (!emittedVerifiableAtom && isSubstantiveSentence(sentence)) {
      atoms.push({
        text: sentence,
        kind: "claim",
        verdict: "unverifiable",
        evidence: "free-text claim; no mechanical check in Tier-1",
      });
    }
  }

  const total = atoms.length;
  if (total === 0) {
    return { atoms, surviving: 0, total: 0, coverage: 0, grade: 0 };
  }

  const surviving = atoms.filter((a) => a.verdict !== "fail").length;
  const verifiable = atoms.filter((a) => a.kind === "number").length;
  const coverage = verifiable / total;
  const grade = clamp01((surviving / total) * coverage);

  return { atoms, surviving, total, coverage, grade };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
