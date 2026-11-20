
import { UiBlockSchema, htmlRendersBlank, type UiBlock } from "@zavi/shared";
import { figureWasRead, recordShownRows, smallIntWasRead } from "@/services/agents/engine/figure-ledger";
import { saveUiBlockArtifact, shownRowsOf } from "@/services/copilotkit/mcp-ui-tools";
import { sanitizePreviewHtml } from "@/services/agents/html-preview-artifacts";

export const MAX_REPLY_CARDS = 2;
const SEQ_BASE = 300;

const CHAR_REF_RE = /&(?:#|[a-z][a-z0-9]*;)/i;
const BLOCK_RE = /<zavi-ui>([\s\S]*?)<\/zavi-ui>/gi;
const OPEN_TAIL_RE = /<zavi-ui>[\s\S]*$/i;
const FENCED_BLOCK_RE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n\s*(<zavi-ui>[\s\S]*?<\/zavi-ui>)\s*\n {0,3}\1[ \t]*$/gim;

export type ReplyCardsState = { seen: Map<string, string>; saved: number };
export const newReplyCardsState = (): ReplyCardsState => ({ seen: new Map(), saved: 0 });

export type ReplyCardsCtx = { tenant_id: string; run_id: string; agent_slug: string };

export type ReplyCardsResult = {
  text: string;
  stats: { found: number; saved: number; as_text: number; invalid: number };
};

export function hasReplyCards(text: string | null | undefined): boolean {
  return typeof text === "string" && /<zavi-ui>/i.test(text);
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

export function cardToText(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const b = raw as Record<string, unknown>;
  const title = str(b.title);
  const head = title ? `**${title}**` : "";
  const lines: string[] = [];
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  switch (b.kind) {
    case "kpi":
      for (const it of arr(b.items)) {
        const i = (it ?? {}) as Record<string, unknown>;
        const delta = str(i.delta);
        lines.push(`- ${str(i.label)}: ${str(i.value)}${delta ? ` (${delta})` : ""}`);
      }
      break;
    case "chart": {
      const unit = str(b.unit);
      for (const p of arr(b.series)) {
        const pt = (p ?? {}) as Record<string, unknown>;
        const v = str(pt.value);
        lines.push(`- ${str(pt.label)}: ${unit === "$" ? `$${v}` : unit ? `${v}${unit}` : v}`);
      }
      break;
    }
    case "table": {
      const cols = arr(b.columns).map(str);
      const rows = arr(b.rows).map((r) => arr(r).map((c) => str(c).replace(/\|/g, "/")));
      if (cols.length > 0) {
        lines.push(`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`);
        for (const r of rows) lines.push(`| ${cols.map((_, k) => r[k] ?? "").join(" | ")} |`);
      }
      break;
    }
    case "posts":
      for (const p of arr(b.posts)) {
        const post = (p ?? {}) as Record<string, unknown>;
        const payload = (post.payload ?? {}) as Record<string, unknown>;
        const parts = [payload.title, payload.text, ...(Array.isArray(payload.thread) ? payload.thread : [])].filter(
          (v): v is string => typeof v === "string" && v.trim().length > 0,
        );
        const body = parts.length > 0 ? parts.join(" / ") : undefined;
        const label = str(post.label) || str(post.channel);
        lines.push(`- ${label}${body ? `: ${body.slice(0, 1000)}` : ""}`);
      }
      break;
    case "html": {
      const plain = str(b.html).replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (plain) lines.push(plain.slice(0, 800));
      break;
    }
    default:
      return "";
  }
  return [head, ...lines].filter(Boolean).join("\n");
}

function numbersIn(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) out.push(String(v));
    else if (typeof v === "string") for (const m of v.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.push(m[0]);
  }
  return out;
}

function wasRead(run_id: string, n: string): boolean {
  return n.replace(/\D/g, "").length >= 2 ? figureWasRead(run_id, n) : /^\d$/.test(n) && smallIntWasRead(run_id, Number(n));
}

function cardNumbers(b: UiBlock): string[] {
  return b.kind === "chart"
    ? numbersIn([...[...b.series, ...(b.compare ?? [])].map((p) => p.value), ...(b.goal !== undefined ? [b.goal] : [])])
    : [];
}

function stripProvenance(raw: Record<string, unknown>): Record<string, unknown> {
  const { verified: _v, receipt: _r, result_id: _id, ...rest } = raw;
  if (rest.kind === "kpi" && Array.isArray(rest.items)) {
    rest.items = rest.items.map((it) => {
      if (!it || typeof it !== "object") return it;
      const { verified: _iv, receipt: _ir, result_id: _iid, ...item } = it as Record<string, unknown>;
      return item;
    });
  }
  return rest;
}

type Prepared = { ok: true; block: UiBlock } | { ok: false; loose: unknown; reason: "json" | "schema" | "html" };

function prepare(json: string, run_id: string): Prepared {
  if (/\\[^"\\nt]/.test(json)) return { ok: false, loose: null, reason: "json" };
  if (CHAR_REF_RE.test(json)) return { ok: false, loose: null, reason: "json" };
  let raw: unknown;
  try {
    raw = JSON.parse(json.trim());
  } catch {
    return { ok: false, loose: null, reason: "json" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, loose: null, reason: "json" };
  const parsed = UiBlockSchema.safeParse(stripProvenance(raw as Record<string, unknown>));
  if (!parsed.success) return { ok: false, loose: raw, reason: "schema" };
  let block = parsed.data;
  if (block.kind === "html") {
    if (/&[#a-z]/i.test(block.html)) return { ok: false, loose: raw, reason: "html" };
    const safe = sanitizePreviewHtml(block.html, { allowScripts: false });
    if (!safe.ok || htmlRendersBlank(safe.html)) return { ok: false, loose: raw, reason: "html" };
    const { scripts: _scripts, ...rest } = block;
    block = { ...rest, html: safe.html };
  }
  const allRead = (nums: string[]) => nums.length > 0 && nums.every((n) => wasRead(run_id, n));
  if (block.kind === "chart") block = { ...block, verified: allRead(cardNumbers(block)) };
  if (block.kind === "kpi") {
    const items = block.items.map((i) => ({ ...i, verified: allRead(numbersIn([i.value, i.delta])) }));
    block = { ...block, items, verified: items.every((i) => i.verified) };
  }
  return { ok: true, block };
}

export async function settleReplyCards(
  text: string,
  ctx: ReplyCardsCtx,
  opts: { save: boolean; state?: ReplyCardsState } = { save: false },
): Promise<ReplyCardsResult> {
  const stats = { found: 0, saved: 0, as_text: 0, invalid: 0 };
  if (!hasReplyCards(text)) return { text, stats };
  text = text.replace(FENCED_BLOCK_RE, "$2");
  const state = opts.state ?? newReplyCardsState();
  const seen = state.seen;
  const parts: Array<string | { json: string }> = [];
  let last = 0;
  for (const m of text.matchAll(BLOCK_RE)) {
    parts.push(text.slice(last, m.index), { json: m[1] });
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(text.slice(last).replace(OPEN_TAIL_RE, ""));

  const out: string[] = [];
  for (const p of parts) {
    if (typeof p === "string") {
      out.push(p);
      continue;
    }
    stats.found += 1;
    const key = p.json.trim();
    if (seen.has(key)) {
      out.push(seen.get(key) ?? "");
      continue;
    }
    let replacement = "";
    try {
      const prep = prepare(p.json, ctx.run_id);
      if (!prep.ok) {
        stats.invalid += 1;
        replacement = cardToText(prep.loose);
      } else if (opts.save && state.saved < MAX_REPLY_CARDS) {
        try {
          await saveUiBlockArtifact(ctx, SEQ_BASE + state.saved, prep.block);
          recordShownRows(ctx.run_id, shownRowsOf(prep.block));
          state.saved += 1;
          stats.saved += 1;
          replacement = "";
        } catch (e) {
          console.warn(`[reply-cards] card save failed, kept as text: ${(e as Error).message}`);
          replacement = cardToText(prep.block);
          stats.as_text += 1;
        }
      } else {
        replacement = cardToText(prep.block);
        stats.as_text += 1;
      }
    } catch (e) {
      console.warn(`[reply-cards] block failed, kept as text: ${(e as Error).message}`);
      stats.invalid += 1;
    }
    seen.set(key, replacement);
    out.push(replacement ? `\n\n${replacement}\n\n` : "\n\n");
  }
  const cleaned = out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleaned, stats };
}
