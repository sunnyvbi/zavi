
import { buildCitationsFromContext } from "./thread-event";
import type { Citation } from "./thread-event-types";

const CITE_TAG_RE = /<cite\s+([^/>]+?)\s*\/>/gi;

const ATTR_RE = /(\w+)="([^"]*)"/g;

export type ParseCitationsResult = {
  text: string;
  citations: Citation[];
};

export function parseCitations(reasoningText: string): ParseCitationsResult {
  if (!reasoningText || typeof reasoningText !== "string") {
    return { text: reasoningText ?? "", citations: [] };
  }

  const memorySet = new Set<string>();
  const runSet = new Set<string>();

  for (const tagMatch of reasoningText.matchAll(CITE_TAG_RE)) {
    const attrsBlob = tagMatch[1];
    for (const attrMatch of attrsBlob.matchAll(ATTR_RE)) {
      const name = attrMatch[1];
      const value = attrMatch[2];
      if (!value) continue;
      const items = value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (name === "memory_anchors" || name === "memory_docs") {
        for (const s of items) memorySet.add(s);
      } else if (name === "agent_runs") {
        for (const u of items) runSet.add(u);
      }
    }
  }

  const cleanText = reasoningText
    .replace(CITE_TAG_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  const citations = buildCitationsFromContext({
    memoryHits: Array.from(memorySet).map((slug) => ({ slug })),
    runRefs: Array.from(runSet).map((run_id) => ({ run_id })),
  });

  return { text: cleanText, citations };
}

export const CITATION_INSTRUCTION = [
  "## Citations",
  "When your reasoning text references a tenant memory anchor (one of: company, ops, policies, disputes, support) or a prior agent run (UUID), emit a self-closing tag at the end of that reasoning paragraph:",
  "",
  '  <cite memory_anchors="slug1,slug2" agent_runs="uuid1,uuid2"/>',
  "",
  "The tag is REMOVED from the visible output and used to render structured chip citations in the UI. Only cite refs you actually used to ground your reasoning. Omit the tag entirely when you have no citations.",
].join("\n");
