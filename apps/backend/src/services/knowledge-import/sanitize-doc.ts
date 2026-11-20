import { sanitizeFetchedContent } from "@/services/onboarding/enrichment/sanitize";

const NL = "\uE000";

export function sanitizeDocumentText(text: string): string {
  const marked = text.replace(/\uE000/g, "").replace(/\r\n?/g, "\n").replace(/\n/g, ` ${NL} `);
  return sanitizeFetchedContent(marked).replace(/ ?\uE000 ?/g, "\n").replace(/[ \t]+\n/g, "\n");
}
