
const TSC_CODE_RE = /\bTS\d{3,5}\b/g;

const FILE_LINE_RE = /[\w./-]+\.[a-z]{1,6}(?:\(\d+,\d+\)|:\d+(?::\d+)?)/gi;

const ESLINT_ROW_RE = /^\d+:\d+\s+(?:error|warning)\s+.+\s+(\S+)\s*$/;

const EXPECT_RECEIVE_RE = /^[-+]?\s*(Expected|Received):\s*(.+)$/;

const DIFF_HEADER_RE = /^[-+]?\s*(Expected|Received)\s*$/;
const DIFF_VALUE_RE = /^([-+])\s+(.+)$/;

const FAIL_SUITE_RE = /^(?:FAIL|FAILED)\b.*?>\s*(.+)$/;
const FAIL_BULLET_RE = /^(?:✕|✗|×|✖|●)\s+(.+)$/;

export function extractSignals(text: string): string[] {
  const out = new Set<string>();
  const lines = (text ?? "").split("\n");
  let inDiffBlock = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (DIFF_HEADER_RE.test(line)) {
      inDiffBlock = true;
      continue;
    }
    if (inDiffBlock) {
      const diffVal = line.match(DIFF_VALUE_RE);
      if (diffVal) {
        out.add(`${diffVal[1]} ${diffVal[2].trim()}`);
        continue;
      }
      if (line !== "") inDiffBlock = false;
    }

    if (!line) continue;

    for (const m of line.matchAll(TSC_CODE_RE)) out.add(m[0]);
    for (const m of line.matchAll(FILE_LINE_RE)) out.add(m[0]);

    const eslint = line.match(ESLINT_ROW_RE);
    if (eslint) out.add(eslint[1]);

    const exprec = line.match(EXPECT_RECEIVE_RE);
    if (exprec) out.add(`${exprec[1]}: ${exprec[2].trim()}`);

    const failSuite = line.match(FAIL_SUITE_RE);
    if (failSuite) out.add(failSuite[1].trim());
    else {
      const failBullet = line.match(FAIL_BULLET_RE);
      if (failBullet && !/^\d+\s+problem/.test(failBullet[1])) {
        out.add(failBullet[1].trim());
      }
    }
  }
  return [...out];
}
