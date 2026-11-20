
import { describe, it, expect } from "vitest";
import {
  detectCarriedConstants,
  extractModuleConstStrings,
  isAllowedConstantSourcePath,
  type SandboxRunner,
} from "../helper-detection";
import {
  evaluateCtoShipGate,
  collectVerificationNotes,
  unjustifiedCarriedConstants,
  detectUnassertedMocks,
} from "../ship-gate";

const IMAGE_PROMPT_SUFFIX_VALUE = ", no text, no logos, no watermarks";
const SOURCE_PATH = "apps/backend/src/services/reports/deliver-html.ts";

function addedDiff(lines: string[]): string {
  return ["--- a/x", "+++ b/x", "@@ -1,0 +1,1 @@", ...lines.map((l) => `+${l}`)].join(
    "\n",
  );
}

function fakeSandbox(index: Record<string, string[]>): {
  run: SandboxRunner;
  grepped: string[];
} {
  const grepped: string[] = [];
  const run: SandboxRunner = async (cmd: string) => {
    const m = /grep -F -rl .*-- '(.*)' \.$/s.exec(cmd.trim());
    if (!m) return { stdout: "", stderr: "", exit_code: 0 };
    const literal = m[1].replace(/'\\''/g, "'");
    grepped.push(literal);
    const hits = index[literal] ?? [];
    if (hits.length === 0) return { stdout: "", stderr: "", exit_code: 1 };
    return {
      stdout: hits.map((h) => `./${h}`).join("\n"),
      stderr: "",
      exit_code: 0,
    };
  };
  return { run, grepped };
}

describe("extractModuleConstStrings — the false-positive control", () => {
  it("extracts a module-scope string const at or above the length floor", () => {
    const out = extractModuleConstStrings([
      `const IMAGE_PROMPT_SUFFIX = "${IMAGE_PROMPT_SUFFIX_VALUE}";`,
    ]);
    expect(out).toEqual([
      { name: "IMAGE_PROMPT_SUFFIX", value: IMAGE_PROMPT_SUFFIX_VALUE },
    ]);
  });

  it("handles `export const` and a type annotation", () => {
    const out = extractModuleConstStrings([
      `export const A_LONG_ENOUGH_ONE: string = "the quick brown fox jumped over";`,
    ]);
    expect(out).toEqual([
      { name: "A_LONG_ENOUGH_ONE", value: "the quick brown fox jumped over" },
    ]);
  });

  it("does NOT extract numeric / boolean constants — the MAX_RETRIES=3 class", () => {
    expect(
      extractModuleConstStrings([
        "const MAX_RETRIES = 3;",
        "const TIMEOUT_MS = 5000;",
        "const RETRY_BACKOFF = 1.5;",
        "const FEATURE_ENABLED = true;",
        "const DISABLED = false;",
        "const MAX_HERO_IMAGES = 3;",
      ]),
    ).toEqual([]);
  });

  it("does NOT extract short strings (below the 24-char floor)", () => {
    expect(
      extractModuleConstStrings([
        'const MODE = "production";',
        'const SEP = ", ";',
        'const TABLE = "agent_runs";',
        'const NEAR_MISS = "0123456789012345678901";',
      ]),
    ).toEqual([]);
  });

  it("does NOT extract a non-module-scope (indented) const — a local, not an invariant", () => {
    expect(
      extractModuleConstStrings([
        `  const LOCAL_ONE = "${IMAGE_PROMPT_SUFFIX_VALUE}";`,
      ]),
    ).toEqual([]);
  });

  it("does NOT extract an interpolated template literal (the source text is not the value)", () => {
    expect(
      extractModuleConstStrings([
        "const GREETING = `hello there ${name}, welcome back friend`;",
      ]),
    ).toEqual([]);
  });
});

describe("isAllowedConstantSourcePath — widened past lib/utils to cover services/", () => {
  it("covers the #1855 source that the old helper allowlist could not see", () => {
    expect(isAllowedConstantSourcePath(SOURCE_PATH)).toBe(true);
    expect(isAllowedConstantSourcePath("apps/web/src/components/Foo.tsx")).toBe(
      true,
    );
    expect(isAllowedConstantSourcePath("packages/shared/src/x.ts")).toBe(true);
  });

  it("still excludes tests, fixtures, generated, vendored and dotfiles", () => {
    expect(
      isAllowedConstantSourcePath("apps/backend/src/services/x.test.ts"),
    ).toBe(false);
    expect(
      isAllowedConstantSourcePath("apps/backend/src/__tests__/x.ts"),
    ).toBe(false);
    expect(
      isAllowedConstantSourcePath("apps/backend/src/generated/api.ts"),
    ).toBe(false);
    expect(isAllowedConstantSourcePath("apps/backend/src/x.d.ts")).toBe(false);
    expect(isAllowedConstantSourcePath("node_modules/pkg/index.js")).toBe(false);
    expect(isAllowedConstantSourcePath("apps/backend/.env")).toBe(false);
  });
});

describe("detectCarriedConstants — fires on the real #1855 shape", () => {
  it("detects IMAGE_PROMPT_SUFFIX copied from the one other file that holds it", async () => {
    const { run, grepped } = fakeSandbox({
      [IMAGE_PROMPT_SUFFIX_VALUE]: [SOURCE_PATH],
    });

    const result = await detectCarriedConstants({
      files: [
        {
          path: "apps/backend/src/services/reports/deliver-pdf.ts",
          action: "modify",
          diff: addedDiff([
            `const IMAGE_PROMPT_SUFFIX = "${IMAGE_PROMPT_SUFFIX_VALUE}";`,
          ]),
        },
      ],
      run,
    });

    expect(result.carried_constants).toEqual([
      { name: "IMAGE_PROMPT_SUFFIX", source_path: SOURCE_PATH },
    ]);
    expect(result.errors).toEqual([]);
    expect(grepped).toEqual([IMAGE_PROMPT_SUFFIX_VALUE]);
  });

  it("does NOT fire when the literal exists in NO other file (original, not copied)", async () => {
    const { run } = fakeSandbox({});
    const result = await detectCarriedConstants({
      files: [
        {
          path: "apps/backend/src/services/reports/deliver-pdf.ts",
          action: "modify",
          diff: addedDiff([
            `const IMAGE_PROMPT_SUFFIX = "${IMAGE_PROMPT_SUFFIX_VALUE}";`,
          ]),
        },
      ],
      run,
    });
    expect(result.carried_constants).toEqual([]);
  });

  it("does NOT fire when the literal is boilerplate in MANY files (ambiguous source)", async () => {
    const { run } = fakeSandbox({
      [IMAGE_PROMPT_SUFFIX_VALUE]: [
        SOURCE_PATH,
        "apps/backend/src/services/reports/deliver-email.ts",
        "apps/web/src/lib/images.ts",
      ],
    });
    const result = await detectCarriedConstants({
      files: [
        {
          path: "apps/backend/src/services/reports/deliver-pdf.ts",
          action: "modify",
          diff: addedDiff([
            `const IMAGE_PROMPT_SUFFIX = "${IMAGE_PROMPT_SUFFIX_VALUE}";`,
          ]),
        },
      ],
      run,
    });
    expect(result.carried_constants).toEqual([]);
  });

  it("does NOT grep numeric constants at all — no sandbox cost, no FP surface", async () => {
    const { run, grepped } = fakeSandbox({});
    const result = await detectCarriedConstants({
      files: [
        {
          path: "apps/backend/src/services/reports/deliver-pdf.ts",
          action: "modify",
          diff: addedDiff([
            "const MAX_RETRIES = 3;",
            "const TIMEOUT_MS = 5000;",
            "const MAX_HERO_IMAGES = 3;",
          ]),
        },
      ],
      run,
    });
    expect(result.carried_constants).toEqual([]);
    expect(grepped).toEqual([]);
  });

  it("fails OPEN when the sandbox grep errors — a detection failure never blocks a PR", async () => {
    const run: SandboxRunner = async () => ({
      stdout: "",
      stderr: "grep: exhausted",
      exit_code: 2,
    });
    const result = await detectCarriedConstants({
      files: [
        {
          path: "apps/backend/src/services/reports/deliver-pdf.ts",
          action: "modify",
          diff: addedDiff([
            `const IMAGE_PROMPT_SUFFIX = "${IMAGE_PROMPT_SUFFIX_VALUE}";`,
          ]),
        },
      ],
      run,
    });
    expect(result.carried_constants).toEqual([]);
    expect(result.errors[0]).toContain("const_grep_failed");
  });
});

function envelopeWith(extra: Record<string, unknown>) {
  return {
    risk_class: "medium",
    test_results: { passed: 15, failed: 0 },
    files: [],
    ...extra,
  };
}

describe("ship-gate — carried constant is WARN-ONLY on day one", () => {
  it("a detected + UNJUSTIFIED carried constant still SHIPS, and warns", () => {
    const env = envelopeWith({
      carried_constants: [
        { name: "IMAGE_PROMPT_SUFFIX", source_path: SOURCE_PATH },
      ],
    });

    const gate = evaluateCtoShipGate(env);
    expect(gate.shippable).toBe(true);

    const notes = collectVerificationNotes(env);
    const note = notes.find((n) => n.startsWith("Carried constant:"));
    expect(note).toBeDefined();
    expect(note).toContain("IMAGE_PROMPT_SUFFIX");
    expect(note).toContain(SOURCE_PATH);
  });

  it("a carried constant WITH a matching note produces no warning", () => {
    const env = envelopeWith({
      carried_constants: [
        { name: "IMAGE_PROMPT_SUFFIX", source_path: SOURCE_PATH },
      ],
      carried_constant_notes: [
        {
          name: "IMAGE_PROMPT_SUFFIX",
          source_path: SOURCE_PATH,
          why_it_holds:
            "The PDF report renders the same marketing hero imagery as the HTML report, so suppressing baked-in text is still correct here.",
        },
      ],
    });

    expect(evaluateCtoShipGate(env).shippable).toBe(true);
    expect(
      collectVerificationNotes(env).filter((n) =>
        n.startsWith("Carried constant:"),
      ),
    ).toEqual([]);
  });

  it("a note for a DIFFERENT constant does not justify the carried one", () => {
    const env = envelopeWith({
      carried_constants: [
        { name: "IMAGE_PROMPT_SUFFIX", source_path: SOURCE_PATH },
      ],
      carried_constant_notes: [
        {
          name: "SOME_OTHER_CONST",
          source_path: SOURCE_PATH,
          why_it_holds: "This one is fine because it is about something else.",
        },
      ],
    });
    expect(unjustifiedCarriedConstants(env)).toEqual([
      { name: "IMAGE_PROMPT_SUFFIX", source_path: SOURCE_PATH },
    ]);
    expect(evaluateCtoShipGate(env).shippable).toBe(true);
  });

  it("no carried_constants stamped (the overwhelmingly common PR) → inert", () => {
    const env = envelopeWith({});
    expect(evaluateCtoShipGate(env).shippable).toBe(true);
    expect(
      collectVerificationNotes(env).filter((n) =>
        n.startsWith("Carried constant:"),
      ),
    ).toEqual([]);
  });
});

const MOCKING_TEST_NO_ASSERTION = `
import { vi, it, expect } from "vitest";
vi.mock("../images/generate-platform-image");
it("renders sections", async () => {
  const html = await renderReport(sections);
  expect(html).toContain("<section>");
});
`;

const MOCKING_TEST_WITH_ARG_ASSERTION = `
import { vi, it, expect } from "vitest";
vi.mock("../images/generate-platform-image");
it("passes the prompt through", async () => {
  await renderReport(sections);
  expect(generatePlatformImage).toHaveBeenCalledWith(
    expect.objectContaining({ prompt: "a logo concept" }),
  );
});
`;

describe("detectUnassertedMocks — tests that prove nothing", () => {
  it("fires on a test file that mocks a module and never asserts its call args", () => {
    expect(
      detectUnassertedMocks([
        {
          path: "apps/backend/src/services/reports/__tests__/deliver-pdf.test.ts",
          action: "create",
          content: MOCKING_TEST_NO_ASSERTION,
        },
      ]),
    ).toEqual([
      "apps/backend/src/services/reports/__tests__/deliver-pdf.test.ts",
    ]);
  });

  it("does NOT fire when toHaveBeenCalledWith is present — this is #1855's remediation", () => {
    expect(
      detectUnassertedMocks([
        {
          path: "apps/backend/src/services/reports/__tests__/deliver-pdf.test.ts",
          action: "create",
          content: MOCKING_TEST_WITH_ARG_ASSERTION,
        },
      ]),
    ).toEqual([]);
  });

  it("does NOT fire on a test file with no mocks at all", () => {
    expect(
      detectUnassertedMocks([
        {
          path: "apps/backend/src/lib/__tests__/pure.test.ts",
          action: "create",
          content: 'it("adds", () => { expect(add(1, 2)).toBe(3); });',
        },
      ]),
    ).toEqual([]);
  });

  it("does NOT fire on non-test files that happen to contain vi.mock in a string", () => {
    expect(
      detectUnassertedMocks([
        {
          path: "apps/backend/src/lib/docs.ts",
          action: "modify",
          diff: addedDiff(['const TIP = "call vi.mock(\'x\') in your test";']),
        },
      ]),
    ).toEqual([]);
  });

  it("a bare toHaveBeenCalled() does NOT count as an argument assertion", () => {
    expect(
      detectUnassertedMocks([
        {
          path: "apps/backend/src/services/reports/__tests__/deliver-pdf.test.ts",
          action: "create",
          content: `vi.mock("../images/generate");\nit("x", () => { expect(gen).toHaveBeenCalled(); });`,
        },
      ]),
    ).toEqual([
      "apps/backend/src/services/reports/__tests__/deliver-pdf.test.ts",
    ]);
  });

  it("WARNS but never blocks — a mock-only test file still ships", () => {
    const env = envelopeWith({
      files: [
        {
          path: "apps/backend/src/services/reports/__tests__/deliver-pdf.test.ts",
          action: "create",
          content: MOCKING_TEST_NO_ASSERTION,
        },
      ],
    });

    expect(evaluateCtoShipGate(env).shippable).toBe(true);

    const note = collectVerificationNotes(env).find((n) =>
      n.startsWith("Tests prove nothing:"),
    );
    expect(note).toBeDefined();
    expect(note).toContain("deliver-pdf.test.ts");
    expect(note).toContain("toHaveBeenCalledWith");
  });
});
