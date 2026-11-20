
import { classifyReadPath, readPathFromInput } from "./engine/source-kind";
import type { ToolCallTrace } from "@/services/tools/types";

export const DOC_ONLY_CLAIM_AGENTS: ReadonlySet<string> = new Set(["operator"]);

const MARKER = "<!--doc-only-claim-reshaped-->";

const ATTRIBUTED_RE =
  /\b(the )?(spec|specification|plan|doc|docs|documentation|readme|rfc|proposal|design|ticket|issue)\b|\baccording to\b|\bper the\b|\bintended to\b|\bis supposed to\b|\bwill (be|become|ship)\b|\bproposed\b|\bnot verified\b|\bunverified\b|\bdesign intent\b/i;

const PRESENT_BEHAVIOUR_RE =
  /\b(is|are|becomes?|gets?|gives?|goes|gets sent|sends?|gains?|gate[sd]?|gets paid|gets created|applies|appears?|gets applied|counts?|triggers?|gets triggered|fires?|runs?|happens|occurs|creates?|writes?|reads?|returns?|pays?|splits?|charges?|blocks?|allows?|requires?|enforces?|defaults? to|falls back|receives?|notifies|emails?|pushes)\b/i;

function isStructural(line: string): boolean {
  const t = line.trim();
  return (
    t === "" ||
    t.startsWith("#") ||
    t.startsWith("|") ||
    t.startsWith("```") ||
    t.startsWith(">") ||
    /^[-*+]\s*$/.test(t) ||
    /^\s*\|?[-: ]+\|/.test(t)
  );
}

export interface DocOnlyReshapeResult {
  changed: boolean;
  text: string;
  reshaped: number;
}

export function reshapeDocOnlyClaims(
  replyText: string,
  docOnly: boolean,
): DocOnlyReshapeResult {
  if (!docOnly || !replyText || replyText.includes(MARKER)) {
    return { changed: false, text: replyText, reshaped: 0 };
  }

  let reshaped = 0;
  let inFence = false;

  const lines = replyText.split("\n").map((line) => {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      return line;
    }
    if (inFence || isStructural(line)) return line;

    const m = /^(\s*(?:[-*+]|\d+[.)])\s+)?(.*)$/.exec(line);
    const prefix = m?.[1] ?? "";
    const body = m?.[2] ?? line;
    if (!body.trim()) return line;
    if (ATTRIBUTED_RE.test(body)) return line;
    if (!PRESENT_BEHAVIOUR_RE.test(body)) return line;

    reshaped += 1;
    const attributed = body.replace(
      /^(The|This|That|These|Those|A|An|It|Each|Every|Any|All|Both|Once|When|If|After|Before|There|They|You|Your|We|Our)\b/,
      (w) => w.toLowerCase(),
    );
    return `${prefix}Per the spec, ${attributed}`;
  });

  if (reshaped === 0) return { changed: false, text: replyText, reshaped: 0 };

  return { changed: true, text: lines.join("\n"), reshaped };
}

const NAMED_READ_TOOLS = /(^|__)(read_file|get_file_contents)$/;

export function isDocOnlyFromTrace(
  toolCalls: readonly ToolCallTrace[] | undefined,
): boolean {
  if (!toolCalls?.length) return false;
  let sawDoc = false;
  for (const c of toolCalls) {
    const name = c?.name ?? "";
    if (!NAMED_READ_TOOLS.test(name)) continue;
    if (c.status !== "ok") continue;
    let path: string | null = null;
    try {
      path = readPathFromInput(JSON.parse(c.input_preview || "{}"));
    } catch {
      path = null;
    }
    if (!path) continue;
    if (classifyReadPath(path) === "source") return false;
    sawDoc = true;
  }
  return sawDoc;
}

export function verifyDocOnlyClaims(args: {
  agentSlug: string;
  text: string;
  toolCalls?: readonly ToolCallTrace[];
}): DocOnlyReshapeResult {
  if (!DOC_ONLY_CLAIM_AGENTS.has(args.agentSlug)) {
    return { changed: false, text: args.text, reshaped: 0 };
  }
  try {
    return reshapeDocOnlyClaims(args.text, isDocOnlyFromTrace(args.toolCalls));
  } catch {
    return { changed: false, text: args.text, reshaped: 0 };
  }
}
