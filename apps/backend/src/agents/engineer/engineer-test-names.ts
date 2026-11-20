
export type FailingTest = string;

export type TestNameParse = {
  runner: "vitest" | "jest" | "pytest" | "go" | "unknown";
  names: FailingTest[];
  confidence: "high" | "none";
};

const EMPTY: TestNameParse = { runner: "unknown", names: [], confidence: "none" };

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function finish(runner: TestNameParse["runner"], raw: string[]): TestNameParse {
  const names = Array.from(new Set(raw.map(norm).filter((n) => n.length > 0))).sort();
  if (names.length === 0) return EMPTY;
  return { runner, names, confidence: "high" };
}

const VITEST_FAIL = /^\s*FAIL\s+(\S+?)\s*>\s*(.+?)\s*$/gm;

const JEST_BULLET = /^\s*●\s+(?!Console|Validation)(.+?)\s*$/gm;

const PYTEST_FAILED = /^\s*FAILED\s+(\S+?::\S+)/gm;

const GO_FAIL = /^\s*---\s+FAIL:\s+(\S+)/gm;

export function parseFailingTestNames(output: string): TestNameParse {
  if (typeof output !== "string" || output.length === 0) return EMPTY;

  const pytest = [...output.matchAll(PYTEST_FAILED)].map((m) => m[1]);
  if (pytest.length > 0) return finish("pytest", pytest);

  const go = [...output.matchAll(GO_FAIL)].map((m) => m[1]);
  if (go.length > 0) return finish("go", go);

  const vitest = [...output.matchAll(VITEST_FAIL)].map((m) => `${m[1]} > ${m[2]}`);
  if (vitest.length > 0) return finish("vitest", vitest);

  const jest = [...output.matchAll(JEST_BULLET)].map((m) => m[1]);
  if (jest.length > 0) return finish("jest", jest);

  return EMPTY;
}

export function newlyFailing(
  head: TestNameParse,
  base: TestNameParse,
): FailingTest[] | null {
  if (head.confidence !== "high") return null;
  if (base.confidence !== "high") return null;
  const wasFailing = new Set(base.names);
  return head.names.filter((n) => !wasFailing.has(n));
}
