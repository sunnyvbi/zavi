
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

export type SubjectClassification = "in-set" | "reasoned-exclude";

export interface CompletenessGate {
  name: string;
  enumerateSubjects: () => string[];
  classify: (subject: string) => SubjectClassification;
  reasonedExclusions?: Record<string, string>;
}

export interface GateEvaluation {
  subjects: string[];
  uncovered: string[];
  staleExclusions: string[];
  misleadingExclusions: string[];
  blankExclusions: string[];
}

const REGISTRY: CompletenessGate[] = [];

export function registerCompletenessGate(gate: CompletenessGate): CompletenessGate {
  REGISTRY.push(gate);
  return gate;
}

export function getRegisteredGates(): readonly CompletenessGate[] {
  return REGISTRY;
}

export function resetCompletenessGates(): void {
  REGISTRY.length = 0;
}

export function evaluateGate(gate: CompletenessGate): GateEvaluation {
  const subjects = gate.enumerateSubjects();
  const excl = gate.reasonedExclusions ?? {};
  const subjectSet = new Set(subjects);

  const uncovered: string[] = [];
  for (const subject of subjects) {
    if (gate.classify(subject) === "in-set") continue;
    const reason = excl[subject];
    const documented = typeof reason === "string" && reason.trim().length > 0;
    if (!documented) uncovered.push(subject);
  }

  const staleExclusions = Object.keys(excl).filter((k) => !subjectSet.has(k));
  const misleadingExclusions = Object.keys(excl).filter(
    (k) => subjectSet.has(k) && gate.classify(k) === "in-set",
  );
  const blankExclusions = Object.keys(excl).filter((k) => {
    const r = excl[k];
    return !(typeof r === "string" && r.trim().length > 0);
  });

  return {
    subjects,
    uncovered,
    staleExclusions,
    misleadingExclusions,
    blankExclusions,
  };
}

export function enumerateLiveAgentSlugs(agentsRoot: string): string[] {
  if (!fs.existsSync(agentsRoot)) return [];
  return fs
    .readdirSync(agentsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .filter((slug) => fs.existsSync(path.join(agentsRoot, slug, "agent.md")))
    .sort();
}

export function enumerateAgentsWithCapability(
  agentsRoot: string,
  flag: "money_path" | "reads_operator_db" | "emits_artifact" | "structured_clarifications",
): Set<string> {
  const out = new Set<string>();
  for (const slug of enumerateLiveAgentSlugs(agentsRoot)) {
    try {
      const raw = fs.readFileSync(path.join(agentsRoot, slug, "agent.md"), "utf8");
      const fm = matter(raw).data as Record<string, unknown>;
      const caps = (
        (fm.metadata as Record<string, unknown> | undefined)?.praxis as
          | Record<string, unknown>
          | undefined
      )?.capabilities as Record<string, unknown> | undefined;
      if (caps && caps[flag] === true) out.add(slug);
    } catch {
    }
  }
  return out;
}

export function extractSetMembers(
  filePath: string,
  constName: string,
  tokenRe: RegExp = /["']([a-z0-9][a-z0-9_-]*)["']/g,
): Set<string> {
  const src = fs.readFileSync(filePath, "utf8");
  const declIdx = src.indexOf(constName);
  if (declIdx === -1) {
    throw new Error(
      `gate-completeness: const \`${constName}\` not found in ${filePath} ` +
        `(renamed or removed? the gate must be updated).`,
    );
  }
  const setIdx = src.indexOf("new Set([", declIdx);
  if (setIdx === -1) {
    throw new Error(
      `gate-completeness: \`new Set([\` not found after \`${constName}\` in ${filePath}.`,
    );
  }
  const open = src.indexOf("[", setIdx);
  const close = src.indexOf("]", open);
  if (close === -1) {
    throw new Error(
      `gate-completeness: unterminated \`new Set([\` for \`${constName}\` in ${filePath}.`,
    );
  }
  const body = src
    .slice(open + 1, close)
    .replace(/\/\/[^\n]*/g, "");
  const members = new Set<string>();
  for (const m of body.matchAll(tokenRe)) {
    members.add(m[1]);
  }
  return members;
}

export const TOOL_TOKEN_RE = /["']([a-z0-9][a-z0-9_.-]*)["']/g;
