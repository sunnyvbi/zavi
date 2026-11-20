
import { splitSources } from "@zavi/shared";
import { splitHandoffHeader } from "./channelMention";
import type { ChatRow } from "./useChatThread";

export function replyCopyMarkdown(text: string, fullReplyMarkdown?: string | null): string {
  const lead = splitHandoffHeader(splitSources(text).body).body.trim();
  const full = fullReplyMarkdown ? splitSources(fullReplyMarkdown).body.trim() : "";
  if (!full || full === lead) return lead;
  if (full.startsWith(lead)) return full;
  return lead ? `${lead}\n\n${full}` : full;
}

export function turnCopyByRow(rows: readonly ChatRow[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  let turn: { id: string; md: string }[] = [];
  const close = () => {
    const parts = turn.map((t) => t.md).filter((md) => md.length > 0);
    turn.forEach((t, k) => out.set(t.id, k === turn.length - 1 ? parts.join("\n\n") : null));
    turn = [];
  };
  for (const r of rows) {
    if (r.kind === "chat_user") close();
    if (r.kind !== "chat_assistant") continue;
    const b = r.body as { text?: unknown; fullReplyMarkdown?: unknown } | null;
    const text = typeof b?.text === "string" ? b.text : "";
    const full = typeof b?.fullReplyMarkdown === "string" ? b.fullReplyMarkdown : null;
    turn.push({ id: r.id, md: replyCopyMarkdown(text, full) });
  }
  close();
  return out;
}

const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

const COUNT_LABEL = /·\s*\d+\s*$/;
function isNavParagraph(p: string): boolean {
  const counted = [...p.matchAll(LINK_RE)].filter((m) => m[2]!.startsWith("/") && COUNT_LABEL.test(m[1]!));
  if (counted.length < 3) return false;
  return p.replace(LINK_RE, "").trim().length <= 120;
}

export function cleanCopyMarkdown(md: string, origin: string): string {
  return md
    .split(/\n{2,}/)
    .filter((p) => !isNavParagraph(p))
    .join("\n\n")
    .replace(LINK_RE, (_m, label: string, href: string) =>
      href.startsWith("/") && !href.startsWith("//") ? `[${label}](${origin}${href})` : `[${label}](${href})`,
    )
    .trim();
}

export function markdownToPlainText(md: string, origin: string): string {
  const code: string[] = [];
  const parked = md.replace(/`([^`\n]+)`/g, (_m, c: string) => `\u0000${code.push(c) - 1}\u0000`);
  return parked
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .map((line) =>
      line
        .replace(/^(\s*)#{1,6}\s+/, "$1")
        .replace(/^(\s*)>\s?/, "$1")
        .replace(/^(\s*)[*+]\s+/, "$1- ")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(LINK_RE, (_m, label: string, href: string) =>
          href.startsWith(origin) || label === href || !/^https?:\/\//.test(href) ? label : `${label} (${href})`,
        )
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2"),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => code[Number(i)]!)
    .trim();
}
