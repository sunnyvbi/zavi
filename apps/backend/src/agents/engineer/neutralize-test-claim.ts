
export const NEUTRALIZE_MARKER = "<!--test-claim-neutralized-->";

const NEUTRAL_INLINE = "(test result unverified — see the verified status in this message)";

const COUNT_PASS_SPAN_RE =
  /\b\d+\s*\/\s*\d+\b[^.\n]*?\b(?:pass(?:es|ed|ing)?|green)\b/gi;

const PASS_PHRASE_RE =
  /\b(?:all\s+)?tests?\s+(?:are\s+)?(?:pass(?:es|ed|ing)?|green)\b|\btest\s+suite\s+(?:passes|is\s+green|green)\b|\b(?:everything\s+passes|all\s+green)\b/gi;

const COUNT_RE = /\b\d+\s*\/\s*\d+\b/;
const TEST_WORD_RE = /\btests?\b/i;
const PASS_TOKEN_RE = /(?:\bpass(?:es|ed|ing)?\b|\bgreen\b|✅)/i;

const NEGATION_RE =
  /\b(?:not|no|never|fail(?:s|ed|ing)?|error(?:s|ed|ing)?|if|once|when|unless|will|would|should|hope|expect|after|pending|couldn|didn|won|cannot)\b|n['’]t/i;

export type NeutralizeResult = { text: string; neutralized: boolean };

export function neutralizeSelfReportedTestClaim(input: unknown): NeutralizeResult {
  const text = typeof input === "string" ? input : "";
  if (text.length === 0 || text.includes(NEUTRALIZE_MARKER)) {
    return { text, neutralized: false };
  }

  const lines = text.split("\n");
  let inFence = false;
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*>/.test(line)) continue;
    if (NEGATION_RE.test(line)) continue;

    let newLine = line;
    if (COUNT_RE.test(line) && TEST_WORD_RE.test(line) && PASS_TOKEN_RE.test(line)) {
      newLine = newLine.replace(COUNT_PASS_SPAN_RE, NEUTRAL_INLINE);
    }
    newLine = newLine.replace(PASS_PHRASE_RE, NEUTRAL_INLINE);

    if (newLine !== line) {
      lines[i] = newLine;
      changed = true;
    }
  }

  if (!changed) return { text, neutralized: false };
  return { text: `${lines.join("\n")}\n\n${NEUTRALIZE_MARKER}`, neutralized: true };
}
