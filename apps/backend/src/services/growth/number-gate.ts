
import { answerFigures, figureTokens, proseOnly } from "@/services/agents/answer-sources";
import { digitsOf, figureIsDecisionSource, ledgerIsEmpty, moneyRoundingWasRead } from "@/services/agents/engine/figure-ledger";
import type { GoalMoves } from "./goal-owner";

export type LedgerView = {
  figureWasRead: (run_id: string, figure: string) => boolean;
  ledgerIsEmpty: (run_id: string) => boolean;
  moneyRoundingWasRead?: (run_id: string, amount: string, negative: boolean) => boolean;
};

const REAL_LEDGER: LedgerView = { figureWasRead: figureIsDecisionSource, ledgerIsEmpty, moneyRoundingWasRead };

const SCALED = /^(?:[A-Za-z]|[\s\-–—−‐‑]*\(?\s*(?:k|m|b|t|l|bn|mm|mil|mn|mln|bln|bil|tn|trn|cr|crs|lac|lacs|lk|thousands?|millions?|billions?|trillions?|crores?|lakhs?)(?![a-z]))/i;
const SIGN_MARK = /[-−‐‑‒–—(]/;
const SIGN_WORD = /\b(minus|negative)\b/i;
const SCALE_WORD =
  /\b(thousands?|millions?|billions?|trillions?|crores?|lakhs?|lacs?|mm|bn|mn|mil|mln|bln|bil|tn|trn)\b|[$£€¥₹₩]\s?\d[\d,.]*\s*(?:[kmbtl]|mm|bn|mn|mil|mln|bln|bil|tn|trn|cr|crs|lk)\b|(?<![\d,.])['’‘]?000(?:['’]?s)?\b|\b[kKmMbB](?:€|£|¥|₹|EUR|USD|GBP|INR)|(?:₹|\bINR|\bRs\.?)\s*(?:cr|crs|l|lk)\b/i;
const SCALE_CODE_AMOUNT =
  /\b(?:[A-Z]{3}|Rs\.?)\s?\d[\d,.]*\s*(?:[KkMmBbTtLl]|[Mm][MmNn]|[Bb][Nn]|[Mm][Ii][Ll]|[Mm][Ll][Nn]|[Bb][Ll][Nn]|[Bb][Ii][Ll]|[Tt][Rr]?[Nn]|[Cc][Rr][Ss]?|[Ll][Kk])\b/;
const SCALE_LETTER =
  /(?:\b[A-Z]{3}\s*|\b(?:usd|eur|gbp|inr|cad|aud)\s*|\bRs\.?\s*|[$£€¥₹₩]\s*)(?:[KkMmBbTt]|[Mm][MmNn]|[Bb][Nn]|[Tt][Nn]|[Mm][Ii][Ll]|[Mm][Ll][Nn]|[Bb][Ll][Nn]|[Bb][Ii][Ll])(?![A-Za-z0-9'’&/\-‐‑‒–—−])/;
const SCALE_PAREN = /\(\s*(?:[KMBT]|MM|BN|MN|[kmbt]\.)\.?\s*\)/;
const JOINED_DASH = /(?<=[A-Za-z0-9])[-‐‑‒–—](?=[A-Za-z0-9])/g;
const NUMBER_RANGE = /(?<=\d)\s*[-‐‑‒–—]\s*(?=\d)/g;
const CLOSED_PAREN = /\(([^()]*)\)/g;
const MONEY_RANGE_BEFORE = /\$\s?[\d,]+(?:\.\d+)?\s*[-−‐‑‒–—]\s*$/;
const MONEY_TO_CENT = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?!\d|\.\d)/g;

export function moneyCitations(raw: string, text: string): Array<{ amount: string; negative: boolean }> | null {
  const one = /^\$\s?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})$/.exec(raw.trim());
  if (!one) return null;
  const amount = `${one[1].replace(/,/g, "")}.${one[2]}`;
  if (!text) return [{ amount, negative: false }];
  const prose = proseOnly(text);
  if (SCALE_WORD.test(prose) || SCALE_CODE_AMOUNT.test(prose) || SCALE_LETTER.test(prose) || SCALE_PAREN.test(prose)) return null;
  const anySignWord = SIGN_WORD.test(prose);
  const digits = digitsOf(amount);
  for (const t of figureTokens(text)) {
    if (digitsOf(t) !== digits) continue;
    const m = /^\$\s?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\s?$/.exec(t.trim());
    if (!m || `${m[1].replace(/,/g, "")}.${m[2]}` !== amount) return null;
  }
  const out: Array<{ amount: string; negative: boolean }> = [];
  for (const m of prose.matchAll(MONEY_TO_CENT)) {
    if (`${m[1].replace(/,/g, "")}.${m[2]}` !== amount) continue;
    const at = m.index ?? 0;
    if (SCALED.test(prose.slice(at + m[0].length))) return null;
    const before = prose.slice(Math.max(0, at - 24), at);
    const negative = anySignWord || SIGN_MARK.test(
      before.replace(MONEY_RANGE_BEFORE, "").replace(CLOSED_PAREN, " $1 ").replace(NUMBER_RANGE, " ").replace(JOINED_DASH, " "),
    );
    out.push({ amount, negative });
  }
  return out.length > 0 ? out : null;
}

export const TYPED_MEASURED_BY = "the founder's own number";

export function withheldGoalFigures(payload: unknown): string[] {
  const cg = (payload as { memory?: { cgo_goals?: { goals?: unknown; founder_reply?: { text?: unknown } } } } | null)?.memory?.cgo_goals;
  if (!cg || !Array.isArray(cg.goals)) return [];
  const replyText = typeof cg.founder_reply?.text === "string" ? cg.founder_reply.text : "";
  const restated = new Set(answerFigures(replyText).map(digitsOf));
  const out: string[] = [];
  for (const g of cg.goals as Array<Record<string, unknown>>) {
    if (!g || g.number_trusted !== false || g.measured_by !== TYPED_MEASURED_BY) continue;
    const v = g.current_value;
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!Number.isFinite(n)) continue;
    const s = String(n);
    if (digitsOf(s).length === 0 || restated.has(digitsOf(s))) continue;
    out.push(s);
  }
  return out;
}

export const REPULL_HINT =
  "Re-pull it with growth__get_metric and do any arithmetic with growth__compute before proposing it again.";

export function figureIsSourced(run_id: string, raw: string, ledger: LedgerView = REAL_LEDGER, text = ""): boolean {
  if (ledger.figureWasRead(run_id, raw)) return true;
  const money = moneyCitations(raw, text);
  if (money && money.every((c) => ledger.moneyRoundingWasRead?.(run_id, c.amount, c.negative) === true)) return true;
  if (!raw.includes("%")) return false;
  const shown = raw.replace(/[^0-9.]/g, "");
  const n = Number(shown);
  if (!shown || !Number.isFinite(n)) return false;
  const dec = shown.match(/\.(\d+)/)?.[1].length ?? 0;
  const read = (v: number, places: number, minDigits = 2) => {
    const s = String(Number(v.toFixed(places)));
    return digitsOf(s).length >= minDigits && ledger.figureWasRead(run_id, s);
  };
  if (read(n / 100, dec + 2)) return true;
  for (const extra of [1, 2]) {
    const scale = 10 ** (dec + extra);
    const center = Math.round(n * scale);
    const half = 5 * 10 ** (extra - 1);
    for (let i = center - half; i < center + half; i++) {
      if (i <= 0) continue;
      const pct = i / scale;
      if (Number(pct.toFixed(dec)) !== n) continue;
      if (read(pct / 100, dec + extra + 2)) return true;
      if (extra === 1 && read(pct, dec + extra, 3)) return true;
    }
  }
  return false;
}

export function unledgeredFigures(run_id: string, text: string, ledger: LedgerView = REAL_LEDGER): string[] {
  if (!text) return [];
  return answerFigures(text).filter((f) => !figureIsSourced(run_id, f, ledger, text));
}

function refusal(what: string, figures: string[]): string {
  const n = figures.length;
  return `${what}: its reason cites ${n === 1 ? "a figure" : `${n} figures`} nothing that run read. ${REPULL_HINT}`;
}

export function gateMovesOnLedger(
  run_id: string,
  moves: GoalMoves,
  ledger: LedgerView = REAL_LEDGER,
): { moves: GoalMoves; refused: string[] } {
  if (!run_id || ledger.ledgerIsEmpty(run_id)) return { moves, refused: [] };
  const refused: string[] = [];

  const goals = (moves.goals ?? []).map((g) => ({
    ...g,
    moves: (g.moves ?? []).filter((m) => {
      const bad = unledgeredFigures(run_id, m.why ?? "", ledger);
      if (bad.length === 0) return true;
      refused.push(refusal(`Work for ${m.target_agent_slug}`, bad));
      return false;
    }),
  }));

  const goal_changes = (moves.goal_changes ?? []).filter((c) => {
    const bad = unledgeredFigures(run_id, c.why, ledger);
    if (bad.length === 0) return true;
    refused.push(refusal(`Goal change on ${c.goal_id}`, bad));
    return false;
  });

  const channel_changes = (moves.channel_changes ?? []).filter((c) => {
    const bad = unledgeredFigures(run_id, c.why, ledger);
    if (bad.length === 0) return true;
    refused.push(refusal(`Pause ${c.channel_slug}`, bad));
    return false;
  });

  const channel_cards = moves.channel_cards?.filter((c) => {
    if (c.decision !== "approve") return true;
    const bad = unledgeredFigures(run_id, c.why, ledger);
    if (bad.length === 0) return true;
    refused.push(refusal(`Approve card ${c.action_id}`, bad));
    return false;
  });

  return {
    moves: { ...moves, goals, goal_changes, channel_changes, ...(channel_cards ? { channel_cards } : {}) },
    refused,
  };
}
