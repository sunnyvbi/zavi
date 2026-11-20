
export type LeakAction = "untouched" | "cleaned" | "drop";

export type LeakStep = {
  title: string;
  body: string;
  deliverable?: { content: string; label?: string; kind?: string; presentation?: unknown };
};

export type LeakResult<S extends LeakStep> = {
  action: LeakAction;
  step: S;
  rules: string[];
};

const DOUBLE_UNDERSCORE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*__[a-z0-9]+(?:_[a-z0-9]+)*\b/g;
const CODE_SPANS = /```[\s\S]*?```|`[^`\n]*`/g;
const CODE_PATH = /(?:^|[\s(`'"])apps\/[\w.-]+\/[\w./-]+|\b[\w-]+\.tsx?\b/;

export function toolNamespaces(toolNames: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const name of toolNames) {
    const parts = String(name ?? "").split("__");
    if (parts.length >= 2 && parts[parts.length - 2]) out.add(parts[parts.length - 2]);
  }
  return out;
}

export function internalToolNames(text: string, namespaces: ReadonlySet<string>): string[] {
  if (!text || namespaces.size === 0) return [];
  return (text.match(DOUBLE_UNDERSCORE) ?? []).filter((m) => namespaces.has(m.split("__")[0]));
}

export function fieldHasHardLeak(text: string, namespaces: ReadonlySet<string>, paste: boolean): boolean {
  if (!text) return false;
  const scanned = paste ? text : text.replace(CODE_SPANS, "");
  return internalToolNames(scanned, namespaces).length > 0 || (paste && CODE_PATH.test(text));
}

export function hardLeaks(step: LeakStep, namespaces: ReadonlySet<string> = new Set()): string[] {
  const d = step.deliverable;
  const paste = d && d.kind !== "code" ? [d.content, d.label ?? ""] : [];
  const rules: string[] = [];
  const prose = [step.title, step.body].map((t) => (t ?? "").replace(CODE_SPANS, ""));
  if ([...prose, ...paste].some((t) => internalToolNames(t ?? "", namespaces).length > 0)) {
    rules.push("internal_tool_name");
  }
  if (paste.some((t) => CODE_PATH.test(t ?? ""))) rules.push("code_path");
  return rules;
}

const SELF_NOTE_SENTENCE: Array<[string, RegExp]> = [
  ["self_note.em_dash", /\bno em[- ]?dash(?:es)?\b/i],
  ["self_note.swap_test", /\b(?:passes|passed|fails) the swap test\b/i],
  ["self_note.kit_shape", /\bkit shape\s*:/i],
  ["self_note.within_limits", /^(?:both|all) (?:\w+ )?(?:cards|variants|posts|lines)\b[^.]{0,30}\bwithin (?:the )?limits\b/i],
];

const SELF_NOTE_PARAGRAPH = /^\s*(?:\*\*)?swap test(?:\*\*)?\s*:/i;

function keepCase(match: string, replacement: string): string {
  return /^[A-Z]/.test(match) ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;
}

const PHRASES: Array<[string, RegExp, (m: string, ...g: string[]) => string]> = [
  ["run_ref", /\bthis run's\b/gi, (m) => keepCase(m, "today's")],
  ["run_ref", /\bThis run\b/g, () => "Today's check"],
  ["run_ref", /\b(by|from|during|in|for) this run\b/gi, (_m, p) => `${p} today's check`],
  ["run_ref", /\bthis run\b/gi, (m) => keepCase(m, "today")],
  ["run_ref", /\bnext run\b/gi, (m) => keepCase(m, "next check")],
  ["self_note.marked_acted", /\bmarked acted\b/gi, () => "marked done"],
  ["self_note.context_note", /\bcontext note\b/gi, (m) => keepCase(m, "note")],
  ["self_note.ds_tag", /(^|[\s(])ds=[a-z]+\b,?[ \t]*/gi, (_m, p) => p],
  ["status_code", /\breturned (?:a |an )?404\b/gi, () => "returned a not-found response"],
  ["status_code", /\breturned (?:a |an )?(?:401|403)\b/gi, () => "returned an access-blocked response"],
  ["status_code", /\breturned (?:a |an )?5\d\d\b/gi, () => "returned a server-error response"],
];

const CODE_SPAN = /(```[\s\S]*?```|`[^`\n]*`)/;

function outsideCode(text: string, fn: (prose: string) => string): string {
  return text
    .split(CODE_SPAN)
    .map((seg, i) => (i % 2 === 1 ? seg : fn(seg)))
    .join("");
}

const THIRD_TO_SECOND: Record<string, string> = {
  says: "say",
  agrees: "agree",
  approves: "approve",
  confirms: "confirm",
  decides: "decide",
  clears: "clear",
  replies: "reply",
};
const VERBS = Object.keys(THIRD_TO_SECOND).join("|");
const CONJS = "if|once|when|until|after|before|the moment";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function atSentenceStart(text: string, offset: number): boolean {
  return offset === 0 || /(?:[.!?:]\s+|\n\s*)$/.test(text.slice(0, offset));
}

function secondPerson(text: string, who: string): string {
  const w = escapeRe(who);
  return text
    .replace(new RegExp(`\\b(Ask|ask) ${w} (if|whether) (?:he|she|they) `, "g"), (_m, a: string, c: string) =>
      `${a === "Ask" ? "Decide" : "decide"} ${c} you `,
    )
    .replace(new RegExp(`\\s+with ${w}(?=[.,;:!?)]|$)`, "g"), "")
    .replace(new RegExp(`\\b${w}'s\\b`, "g"), (_m, offset: number, all: string) =>
      atSentenceStart(all, offset) ? "Your" : "your",
    )
    .replace(new RegExp(`\\bfor ${w} to\\b`, "g"), "for you to")
    .replace(
      new RegExp(`\\b(${CONJS}) ${w} (${VERBS})\\b`, "gi"),
      (_m, conj: string, verb: string) => `${conj} you ${THIRD_TO_SECOND[verb.toLowerCase()]}`,
    );
}

function removeSelfNoteSentences(text: string, fired: Set<string>): string {
  let removed = false;
  let inFence = false;
  const lines = text.split("\n").flatMap((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return [line];
    }
    if (inFence || line.includes("`")) return [line];
    if (SELF_NOTE_PARAGRAPH.test(line)) {
      fired.add("self_note.swap_test");
      removed = true;
      return [];
    }
    const parts = line.split(/(?<=[.!?]["')\]]?)(\s+)/);
    const kept: string[] = [];
    let hit = false;
    for (let i = 0; i < parts.length; i += 2) {
      const sentence = parts[i] ?? "";
      const rule = SELF_NOTE_SENTENCE.find(([, re]) => re.test(sentence.trim()));
      if (rule) {
        fired.add(rule[0]);
        hit = true;
        continue;
      }
      kept.push(sentence, parts[i + 1] ?? "");
    }
    if (!hit) return [line];
    removed = true;
    const joined = kept.join("").trimEnd();
    return joined.trim() ? [joined] : [];
  });
  return removed ? lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() : text;
}

export function cleanText(
  text: string,
  opts: { founderName?: string | null; prose: boolean },
): { text: string; rules: string[] } {
  if (!text) return { text, rules: [] };
  const fired = new Set<string>();
  let out = removeSelfNoteSentences(text, fired);
  for (const [id, re, to] of PHRASES) {
    const next = outsideCode(out, (p) => p.replace(re, to as (m: string, ...a: unknown[]) => string));
    if (next !== out) fired.add(id);
    out = next;
  }
  if (opts.prose) {
    const whos: Array<[string, string]> = [
      ["the_founder", "the founder"],
      ["the_founder", "The founder"],
    ];
    if (opts.founderName) whos.push(["founder_name", opts.founderName]);
    for (const [id, who] of whos) {
      const next = outsideCode(out, (p) => secondPerson(p, who));
      if (next !== out) fired.add(id);
      out = next;
    }
  }
  return { text: out, rules: [...fired] };
}

export function applyLeakGateToStep<S extends LeakStep>(
  step: S,
  opts: { founderName?: string | null; namespaces?: ReadonlySet<string> } = {},
): LeakResult<S> {
  const hard = hardLeaks(step, opts.namespaces);
  if (hard.length > 0) return { action: "drop", step, rules: hard };

  const rules = new Set<string>();
  const take = (r: { text: string; rules: string[] }, original: string): string => {
    r.rules.forEach((x) => rules.add(x));
    return r.text.trim() ? r.text : original;
  };
  const title = take(cleanText(step.title, { founderName: opts.founderName, prose: true }), step.title);
  const body = take(cleanText(step.body, { founderName: opts.founderName, prose: true }), step.body);
  let deliverable = step.deliverable;
  if (deliverable && deliverable.kind !== "code") {
    const content = take(cleanText(deliverable.content, { prose: false }), deliverable.content);
    const label =
      deliverable.label !== undefined ? take(cleanText(deliverable.label, { prose: false }), deliverable.label) : undefined;
    deliverable = { ...deliverable, content, ...(label !== undefined ? { label } : {}) };
  }
  if (rules.size === 0) return { action: "untouched", step, rules: [] };
  return { action: "cleaned", step: { ...step, title, body, ...(deliverable ? { deliverable } : {}) }, rules: [...rules] };
}

export function usableFounderName(fullName: string | null | undefined, companyNames: string[]): string | null {
  const name = (fullName ?? "").trim().replace(/\s+/g, " ");
  if (!/^[A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'.-]+)+$/.test(name)) return null;
  const lower = name.toLowerCase();
  if (companyNames.some((n) => n.toLowerCase().includes(lower))) return null;
  return name;
}
