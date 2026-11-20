
import { z } from "zod";
import { clipKeepingLines } from "@/services/growth/question-text";

export const RATIONALE_MAX = 500;

export function fitRationale(value: unknown, max: number = RATIONALE_MAX): unknown {
  if (typeof value !== "string" || value.length <= max) return value;
  return clipKeepingLines(value, max);
}

export function rationaleInput(max: number = RATIONALE_MAX) {
  return z.preprocess((v) => fitRationale(v, max), z.string().min(1).max(max));
}

export function rationaleBody(max: number = RATIONALE_MAX) {
  return z.preprocess((v) => fitRationale(v, max), z.string().max(max)).default("");
}

const BACKSTAGE = new RegExp(
  [
    String.raw`\b(?:this|previous|prior|earlier)\s+run\b(?![-'\u2019]|\s+(?:of|club|clubs|to|for)\b)`,
    String.raw`\b(?:page|pages|thread|threads|doc|docs|source|sources)\s+(?:i\s+|you\s+|we\s+)?(?:read|fetched|checked|crawled|scraped)\b(?!\s+(?:out|by|off|in)\b)`,
    String.raw`\b(?:i|we)\s+(?:read|fetched|checked|crawled|scraped)\s+(?:a\s+|any\s+|the\s+)?pages?\b`,
    String.raw`\b(?:fetched|crawled|scraped)\s+(?:a\s+|any\s+|the\s+)?pages?\b`,
    String.raw`\b(?:my|its)\s+(?:instructions|prompt|system prompt)\b`,
    String.raw`\bthe\s+system\s+prompt\b`,
    String.raw`\b(?:tool call|tool result)s?\b(?!-)`,
  ].join("|"),
  "i",
);
const TOOL_NAME = /(?<![\w{|=%$.:/#&?@*-])[a-z][a-z0-9_]*__[a-z0-9_]+(?![\w}|\]=*-])/;

function backstageAt(text: string): number {
  const at = [BACKSTAGE.exec(text)?.index, TOOL_NAME.exec(text)?.index].filter((i): i is number => i !== undefined);
  return at.length ? Math.min(...at) : -1;
}
const CONNECTIVE = /(?:\s*[,;:\u2014]\s*|\s+-\s+|\s+(?:because|since|as|given that|until|unless|so|but|and)\s+)/gi;

function plainSentence(sentence: string): string {
  const hit = backstageAt(sentence);
  if (hit < 0) return sentence;
  let cut = -1;
  for (const m of sentence.slice(0, hit).matchAll(CONNECTIVE)) cut = m.index ?? cut;
  if (cut < 0) return "";
  const head = sentence.slice(0, cut).replace(/[\s,;:\u2014-]+$/, "");
  if (head.split(/\s+/).filter(Boolean).length < 2) return "";
  const end = /[.!?]+\s*$/.exec(sentence)?.[0].trim() || ".";
  return `${head}${end}`;
}

export function plainRationale(value: unknown): unknown {
  if (typeof value !== "string" || backstageAt(value) < 0) return value;
  return value
    .split("\n")
    .map((line) =>
      line
        .split(/(?<=[.!?])\s+/)
        .map((s) => plainSentence(s.trim()))
        .filter(Boolean)
        .join(" "),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function rationaleOptional(max: number = RATIONALE_MAX) {
  return z.preprocess((v) => fitRationale(plainRationale(v), max), z.string().max(max)).optional();
}
