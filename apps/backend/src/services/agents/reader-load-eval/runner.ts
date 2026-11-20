
export type ReaderLoadGolden = {
  name: string;
  question: string;
  output: string;
  expect_pass: boolean;
};

const LEAD_MAX_CHARS = 180;
const MAX_LINES_BEFORE_HEADER = 8;

function isHeader(line: string): boolean {
  return /^\s{0,3}#{1,6}\s/.test(line);
}

export function isGraspable(output: string): boolean {
  const lines = output.split("\n");
  const meaningful = lines.filter((l) => l.trim().length > 0);
  if (meaningful.length === 0) return false;

  const firstMeaningful = meaningful[0];
  if (isHeader(firstMeaningful)) return false;
  const firstSentence = firstMeaningful.trim().split(/(?<=[.!?])\s/)[0] ?? "";
  if (firstSentence.length > LEAD_MAX_CHARS) return false;

  let linesBeforeHeader = 0;
  for (const l of meaningful) {
    if (isHeader(l)) break;
    linesBeforeHeader += 1;
  }
  const hasHeader = meaningful.some(isHeader);
  if (hasHeader && linesBeforeHeader > MAX_LINES_BEFORE_HEADER) return false;

  return true;
}

export type ReaderLoadCaseResult = {
  name: string;
  pass: boolean;
  reason?: string;
};

export type ReaderLoadReport = {
  total: number;
  passed: number;
  accuracy: number;
  cases: ReaderLoadCaseResult[];
};

export function scoreReaderLoad(goldens: readonly ReaderLoadGolden[]): ReaderLoadReport {
  const cases: ReaderLoadCaseResult[] = goldens.map((g) => {
    const got = isGraspable(g.output);
    const pass = got === g.expect_pass;
    return {
      name: g.name,
      pass,
      reason: pass
        ? undefined
        : `expected graspable=${g.expect_pass}, got ${got}`,
    };
  });
  const passed = cases.filter((c) => c.pass).length;
  return {
    total: cases.length,
    passed,
    accuracy: cases.length === 0 ? 1 : passed / cases.length,
    cases,
  };
}
