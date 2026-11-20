
import { mdToMrkdwn } from "@/services/tools/slack/mrkdwn";

export function chunkText(text: string, size: number): string[] {
  if (text.length === 0) return [];
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (line.length > size) {
      if (buf.length > 0) {
        chunks.push(buf);
        buf = "";
      }
      for (let i = 0; i < line.length; i += size) {
        chunks.push(line.slice(i, i + size));
      }
      continue;
    }
    const next = buf.length === 0 ? line : `${buf}\n${line}`;
    if (next.length > size) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = next;
    }
  }
  if (buf.length > 0) chunks.push(buf);
  return chunks;
}

const PRECEDING_NARRATION_RE =
  /^(now\b|let me (?!know\b|get back)|let'?s (check|start|add|apply|do|look|run|verify|wire)|first[,\s]|next[,\s]|then[,\s]|wire\b|clear (the|it)\b|i'?ll (now|check|add|wire|apply|edit|implement|start|run|verify|extend|update)|i will (now|check|add|apply|implement)|okay,? (now|let)|alright,? (now|let)|add (the|a) )/i;
const PRECEDING_INTERNAL_ACTION_RE =
  /^(checking|check|look(?:ing)? at|open(?:ing)?|read(?:ing)?|add(?:ing)?|apply(?:ing)?|run(?:ning)?|verify(?:ing)?|wire|wiring|update|updating|fix(?:ing)?|test(?:ing)?|inspect(?:ing)?)\b/i;

const WORK_VERB =
  String.raw`check|re-?check|run(?! through)|re-?run|add|wire|apply|edit|implement|start|verify|confirm|extend|update|investigate|pull|read|look|open|restore|find|grab|inspect|test|try|emit|generate|make|fix|sweep|patch|install|upload|post|send|scan|trace|dig`;
const WORK_ADVERB =
  String.raw`now|just|first|go|also|then|next|quickly|manually|actually|really|finally|briefly|carefully|properly|simply|directly`;
const WORK_ADVERBS = String.raw`(?:(?:${WORK_ADVERB})\s+){0,2}`;
export const WORK_INTENT_ANYWHERE_RE = new RegExp(
  String.raw`(\blet me ${WORK_ADVERBS}(?:${WORK_VERB})\b` +
    String.raw`|\bi'?ll ${WORK_ADVERBS}(?:${WORK_VERB})\b` +
    String.raw`|\bnow (?:let me|i'?ll)\b` +
    String.raw`|\bnow (?:opening|reading|adding|running|generating|checking|wiring|uploading|posting)\b)`,
  "i",
);

const INTERNAL_CONTROL_BLOCK_RE = /<\/?(?:plan|envelope|thinking|scratchpad)\b/i;

const DEV_WORKHUMAN_RE =
  /\b(?:typecheck|tsc|vitest|jest|lint(?:er|ing)?|shard|test suite|dist|rebase|worktree|ci)\b|\b\d+\/\d+ (?:pass|green)|\b\d+ tests? pass|\.(?:ts|tsx|js|jsx|mjs|py|rb|go|swift|kt|java|sql|css|json|ya?ml|env)\b/i;
const NEXT_MOVE_RE = /\b(?:now|next|then|re-?run|rebuild)\b/i;
const WORKHUMAN_PROSE_MAX = 240;

const SCRATCHPAD_STEP_RE =
  /^\**step\s*\d[^\n]*(`[^`]+`|\.(?:ts|tsx|js|jsx|mjs|py|rb|go|swift|kt|java|sql|css|json|ya?ml)\b)/i;

export function shouldDropPrecedingTurn(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return true;
  const first = lines[0];
  if (lines.some((l) => WORK_INTENT_ANYWHERE_RE.test(l) || SCRATCHPAD_STEP_RE.test(l))) {
    return true;
  }

  if (lines.some((l) => INTERNAL_CONTROL_BLOCK_RE.test(l))) return true;

  const joined = lines.join(" ");
  if (
    joined.length <= WORKHUMAN_PROSE_MAX &&
    DEV_WORKHUMAN_RE.test(joined) &&
    (NEXT_MOVE_RE.test(joined) ||
      PRECEDING_INTERNAL_ACTION_RE.test(first) ||
      PRECEDING_NARRATION_RE.test(first))
  ) {
    return true;
  }

  let inFence = false;
  const proseLines = lines.filter((l) => {
    if (/^```/.test(l)) {
      inFence = !inFence;
      return false;
    }
    if (inFence) return false;
    return !PRECEDING_NARRATION_RE.test(l) && !PRECEDING_INTERNAL_ACTION_RE.test(l);
  });
  return PRECEDING_NARRATION_RE.test(first) && proseLines.length < 2;
}

const PRECEDING_MIN_PROSE_CHARS = 300;

const PRECEDING_MIN_STRUCTURED_CHARS = 150;

function precedingTurnCarriesStructure(text: string): boolean {
  if (/```/.test(text)) return true;
  if (/^\s*\|.*\|/m.test(text)) return true;
  if ((text.match(/^\s*[-*]\s+\S/gm) || []).length >= 2) return true;
  return false;
}

export function precedingTurnEarnsDelivery(text: string): boolean {
  const len = text.trim().length;
  if (len >= PRECEDING_MIN_PROSE_CHARS) return true;
  return len >= PRECEDING_MIN_STRUCTURED_CHARS && precedingTurnCarriesStructure(text);
}

export function precedingTurnChunks(
  assistant_turns: string[] | null | undefined,
  isError: boolean,
  chunkSize: number,
): string[] {
  if (isError) return [];
  if (!Array.isArray(assistant_turns) || assistant_turns.length < 2) return [];
  return assistant_turns
    .slice(0, -1)
    .filter((turn) => !shouldDropPrecedingTurn(turn))
    .filter((turn) => precedingTurnEarnsDelivery(turn))
    .flatMap((turn) => chunkText(mdToMrkdwn(turn), chunkSize));
}
