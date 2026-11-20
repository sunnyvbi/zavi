
export type SourceKind = "source" | "doc" | "test" | "generated";

const GENERATED_RE =
  /(^|\/)(dist|build|out|coverage|node_modules|\.next|__generated__|generated)(\/|$)/i;

const TEST_RE = /(^|\/)(__tests__|__mocks__|test|tests|spec|e2e|fixtures?)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i;

const DOC_DIR_RE = /(^|\/)(docs?|documentation|adr|rfcs?|specs?|plans?|design|proposals?|notes)(\/|$)/i;
const DOC_EXT_RE = /\.(md|mdx|markdown|rst|adoc|asciidoc|txt)$/i;

export function classifyReadPath(path: string | null | undefined): SourceKind {
  if (!path || typeof path !== "string") return "source";
  const p = path.replace(/^\.?\//, "").trim();
  if (!p) return "source";
  if (GENERATED_RE.test(p)) return "generated";
  if (TEST_RE.test(p)) return "test";
  if (DOC_DIR_RE.test(p) || DOC_EXT_RE.test(p)) return "doc";
  return "source";
}

export function isShippedCode(kind: SourceKind): boolean {
  return kind === "source";
}

export function readPathFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filepath", "file"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function provenanceNote(kind: SourceKind, path: string | null): string | null {
  if (!path) return null;
  switch (kind) {
    case "doc":
      return `source_kind: doc — ${path} is documentation. It states what was INTENDED; the shipped code may differ. Do not describe system behaviour in the present tense from this file alone.`;
    case "test":
      return `source_kind: test — ${path} is a test. It shows asserted behaviour, which may be asserted against a mock.`;
    case "generated":
      return `source_kind: generated — ${path} is build output, not source anyone edits, and may be stale.`;
    case "source":
      return null;
  }
}
