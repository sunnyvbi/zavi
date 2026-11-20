import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Markdown } from "@/components/workspace/Markdown";
import { findBlanks } from "../../blanks";
import { CODE_LINE } from "../cardModel";
import { cardText } from "../styles";

const MARKDOWN_KINDS = new Set(["article", "strategy"]);
const MARKDOWN_AT = 1500;

function marked(text: string, blanks: string[]) {
  if (!blanks.length) return text;
  const parts = text.split(new RegExp(`(${blanks.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`));
  return parts.map((p, i) => (blanks.includes(p)
    ? <mark key={i} className="rounded bg-ca-mark px-1 text-ca-xdark">{p}</mark>
    : <Fragment key={i}>{p}</Fragment>));
}

const BULLET = /^\s*[-*•]\s+/;

export function isLongCopy(text: string, short = false, maxParagraphs = 3): boolean {
  const rows = text.split(/\r?\n/).length;
  if (short) return text.length > 160 || rows > 2;
  return text.length > 420 || rows > 7 || text.split(/\n{2,}/).filter((p) => p.trim()).length > maxParagraphs;
}

type Run = { kind: "list" | "code" | "text"; lines: string[] };

function preview(text: string, short: boolean, long: boolean): { paragraphs: string[][]; clipped: boolean } {
  const limit = long ? (short ? 3 : 6) : Infinity;
  const all = text.split(/\r?\n/).map((l) => l.trimEnd());
  const kept: string[] = [];
  let count = 0;
  let chars = 0;
  for (const line of all) {
    if (line.trim()) {
      if (count === limit || (long && chars > 360)) break;
      count += 1;
      chars += line.length;
    }
    kept.push(line);
  }
  const clipped = kept.length < all.length && all.slice(kept.length).some((l) => l.trim());
  while (kept.length > 1 && (!kept[kept.length - 1]!.trim() || (clipped && /:\s*$/.test(kept[kept.length - 1]!)))) kept.pop();
  const paragraphs: string[][] = [[]];
  for (const line of kept) {
    if (line.trim()) paragraphs[paragraphs.length - 1]!.push(line);
    else if (paragraphs[paragraphs.length - 1]!.length) paragraphs.push([]);
  }
  return { paragraphs: paragraphs.filter((p) => p.length), clipped };
}

function runsOf(lines: string[]): Run[] {
  const runs: Run[] = [];
  for (const line of lines) {
    const kind = BULLET.test(line) ? "list" : CODE_LINE.test(line) ? "code" : "text";
    const value = kind === "list" ? line.replace(BULLET, "") : line.trim();
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.lines.push(value);
    else runs.push({ kind, lines: [value] });
  }
  return runs;
}

function Structured({ text, short, long, testId, render }: { text: string; short: boolean; long: boolean; testId: string; render: (text: string) => ReactNode }) {
  const { paragraphs, clipped } = preview(text, short, long);
  return (
    <div data-testid={testId} data-clipped={clipped || undefined} className="flex min-w-0 flex-col gap-3 break-words [overflow-wrap:anywhere]">
      {paragraphs.map((lines, i) => (
        <div key={i} className="flex min-w-0 flex-col gap-1.5">
          {runsOf(lines).map((run, j) => {
            if (run.kind === "list") return <ul key={j} className="list-disc pl-5">{run.lines.map((l, k) => <li key={k}>{render(l)}</li>)}</ul>;
            if (run.kind === "code") return <pre key={j} className="overflow-hidden whitespace-pre-wrap break-all rounded-lg bg-ca-subtle px-3 py-2 font-code text-ca-code text-ca-xdark">{run.lines.join("\n")}</pre>;
            return <p key={j} className={cn("whitespace-pre-line", long && "line-clamp-4")}>{render(run.lines.join("\n"))}</p>;
          })}
        </div>
      ))}
    </div>
  );
}

export function CopyText({ text, kind, code = false, maxParagraphs, testId = "card-copy-text", short = false, lists = false }: { text: string; kind?: string | null; code?: boolean; maxParagraphs?: number; testId?: string; short?: boolean; lists?: boolean }) {
  const blanks = code ? [] : findBlanks(text, kind);
  const collapsedAt = maxParagraphs ?? 3;
  const long = isLongCopy(text, short, collapsedAt);
  const rendered = !code && ((!!kind && MARKDOWN_KINDS.has(kind)) || text.length > MARKDOWN_AT);
  if (lists && !code && !rendered) return <div className={cardText.body}><Structured text={text} short={short} long={long} testId={testId} render={(t) => marked(t, blanks)} /></div>;
  if (!code && !rendered) {
    return (
      <div className={cardText.body}>
        <div data-testid={testId} data-clipped={long || undefined} className="min-w-0 break-words [overflow-wrap:anywhere]">
          <p className={cn("whitespace-pre-line", long && (short ? "line-clamp-3" : "line-clamp-6"))}>{marked(text.trim(), blanks)}</p>
        </div>
      </div>
    );
  }
  return (
    <div className={cn(code ? "min-w-0 break-all rounded-xl bg-ca-subtle p-3 font-code text-ca-code text-ca-xdark" : cardText.body)}>
      <div data-testid={testId} data-clipped={long || undefined} className={cn("flex min-w-0 flex-col gap-3 break-words [overflow-wrap:anywhere]", long && (short ? "max-h-14" : "max-h-32"), long && cn("relative overflow-hidden after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-8 after:bg-gradient-to-t after:to-transparent", code ? "after:from-ca-subtle" : "after:from-ca-bg"))}>
        {rendered ? <div data-testid="deliverable-markdown"><Markdown source={text} disableActionLinks /></div> : <p className="whitespace-pre-wrap">{text}</p>}
      </div>
    </div>
  );
}
