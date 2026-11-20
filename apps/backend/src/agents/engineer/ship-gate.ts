
import type { VerifyStatus } from "./engineer-verify-receipt";

const BLOCK_ON_MISSING_TESTS = false;

const BLOCK_ON_UNWIRED_EXPORTS = false;

const BLOCK_ON_UNVERIFIED_DIAGNOSIS = true;
const BLOCK_ON_MOCKED_SUSPECT = true;

const BLOCK_ON_CARRIED_CONSTANT = false;

export type ShipBlockReason =
  | "refused_envelope"
  | "prose_fallback"
  | "tests_failed"
  | "typecheck_failed"
  | "tests_missing"
  | "wiring_unverified_block"
  | "app_verify_missing"
  | "mocked_suspect"
  | "diagnosis_unreproduced"
  | "carried_constant_unjustified"
  | "tests_failed_new"
  | "design_fidelity";

export type ShipGateResult =
  | {
      shippable: true;
      tests_warning?: "tests_missing";
      wiring_warning?: "wiring_unverified";
    }
  | { shippable: false; reason: ShipBlockReason };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function readTestCounts(
  env: Record<string, unknown>,
): { passed: number | null; failed: number | null } {
  const tr = asRecord(env.test_results);
  const passed =
    typeof tr.passed === "number" && Number.isFinite(tr.passed)
      ? tr.passed
      : null;
  const failed =
    typeof tr.failed === "number" && Number.isFinite(tr.failed)
      ? tr.failed
      : null;
  return { passed, failed };
}

function readVerifyStatus(env: Record<string, unknown>): VerifyStatus | null {
  const v = asRecord(env.verify);
  const s = v.status;
  return s === "passed" || s === "failed" || s === "couldnt_run" || s === "not_run"
    ? s
    : null;
}

const CAUSAL_FIX_RE =
  /\b(?:root[-\s]?cause|the\s+bug\s+is|caused\s+by|is\s+caused|the\s+(?:issue|problem)\s+is|because\s+the|the\s+culprit|the\s+root\s+of)\b/i;

function hasCausalFixLanguage(env: Record<string, unknown>): boolean {
  const body = typeof env.body === "string" ? env.body : "";
  const rm = typeof env.rendered_markdown === "string" ? env.rendered_markdown : "";
  return CAUSAL_FIX_RE.test(body) || CAUSAL_FIX_RE.test(rm);
}

const MOCK_CALL_RE = /\b(?:vi|jest|vitest)\s*\.\s*(?:mock|doMock)\s*\(\s*['"]([^'"]+)['"]/g;
const TEST_FILE_RE = /\.(?:test|spec)\.[jt]sx?$/;

export function diffMocksModule(files: unknown, rootCauseSymbol: string): boolean {
  const needle = (rootCauseSymbol ?? "").trim().toLowerCase();
  if (!Array.isArray(files) || needle.length === 0) return false;
  for (const f of files) {
    const rec = asRecord(f);
    const path = typeof rec.path === "string" ? rec.path : "";
    if (!TEST_FILE_RE.test(path)) continue;
    const content = typeof rec.content === "string" ? rec.content : "";
    const diff = typeof rec.diff === "string" ? rec.diff : "";
    const hay = `${content}\n${diff}`;
    MOCK_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MOCK_CALL_RE.exec(hay)) !== null) {
      const mocked = m[1].toLowerCase();
      if (mocked === needle) return true;
      const shorter = mocked.length < needle.length ? mocked : needle;
      if (shorter.length >= 4 && (mocked.includes(needle) || needle.includes(mocked))) {
        return true;
      }
    }
  }
  return false;
}

export function unjustifiedCarriedConstants(env: Record<string, unknown>): Array<{
  name: string;
  source_path: string;
}> {
  const raw = Array.isArray(env.carried_constants) ? env.carried_constants : [];
  if (raw.length === 0) return [];

  const notedNames = new Set<string>();
  const notes = Array.isArray(env.carried_constant_notes)
    ? env.carried_constant_notes
    : [];
  for (const n of notes) {
    const rec = asRecord(n);
    if (typeof rec.name === "string" && rec.name.trim().length > 0) {
      notedNames.add(rec.name.trim());
    }
  }

  const out: Array<{ name: string; source_path: string }> = [];
  for (const c of raw) {
    const rec = asRecord(c);
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const source_path =
      typeof rec.source_path === "string" ? rec.source_path : "(unknown)";
    if (name.length === 0) continue;
    if (notedNames.has(name)) continue;
    out.push({ name, source_path });
  }
  return out;
}

const ARG_ASSERTION_RE =
  /\.(?:toHaveBeenCalledWith|toHaveBeenNthCalledWith|toHaveBeenLastCalledWith|toHaveBeenCalledExactlyOnceWith)\b|\.mock\.(?:calls|lastCall)\b/;

export function detectUnassertedMocks(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  const out = new Set<string>();
  for (const f of files) {
    const rec = asRecord(f);
    const path = typeof rec.path === "string" ? rec.path : "";
    if (!TEST_FILE_RE.test(path)) continue;
    if (rec.action === "delete") continue;
    const content = typeof rec.content === "string" ? rec.content : "";
    const diff = typeof rec.diff === "string" ? rec.diff : "";
    const hay = `${content}\n${diff}`;

    const mocked: string[] = [];
    MOCK_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MOCK_CALL_RE.exec(hay)) !== null) mocked.push(m[1]);
    if (mocked.length === 0) continue;

    if (ARG_ASSERTION_RE.test(hay)) continue;
    out.add(path);
  }
  return Array.from(out);
}

export function isTypecheckRed(envelope: unknown): boolean {
  const env = asRecord(envelope);
  const tc = asRecord(env.typecheck_verify);
  const tcServerStatus = typeof tc.status === "string" ? tc.status : undefined;
  if (tcServerStatus === "failed") return true;
  return tcServerStatus !== "passed" && env.typecheck_ok === false;
}

export function evaluateCtoShipGate(envelope: unknown): ShipGateResult {
  const env = asRecord(envelope);

  const wiringWarn: { wiring_warning?: "wiring_unverified" } =
    env.wiring_unverified === true
      ? { wiring_warning: "wiring_unverified" }
      : {};

  if (env.refused === true) {
    return { shippable: false, reason: "refused_envelope" };
  }

  if (
    Array.isArray(env.design_fidelity_substituted) &&
    env.design_fidelity_substituted.length > 0
  ) {
    return { shippable: false, reason: "design_fidelity" };
  }

  if (env.parse_fallback_kind) {
    return { shippable: false, reason: "prose_fallback" };
  }

  const riskClass =
    typeof env.risk_class === "string" ? env.risk_class : undefined;
  const presentsAsProposal =
    env.test_results !== undefined || env.risk_class !== undefined;
  if (riskClass !== "trivial" && presentsAsProposal) {
    const { passed, failed } = readTestCounts(env);
    const verifyStatus = readVerifyStatus(env);
    if (verifyStatus === "failed") {
      const attribution = asRecord(env.test_attribution);
      const attributed = attribution.kind === "attributed";
      const newFailures = Array.isArray(attribution.new_failures)
        ? attribution.new_failures
        : [];

      if (attributed && newFailures.length > 0) {
        return { shippable: false, reason: "tests_failed_new" };
      }

      if (attributed && newFailures.length === 0) {
      } else {
        return { shippable: false, reason: "tests_failed" };
      }
    }
    if (isTypecheckRed(env)) {
      return { shippable: false, reason: "typecheck_failed" };
    }
    if (BLOCK_ON_UNWIRED_EXPORTS && env.wiring_unverified === true) {
      return { shippable: false, reason: "wiring_unverified_block" };
    }
    if (env.http_route_changed === true) {
      const avr = asRecord(env.app_verify_result);
      const status = typeof avr.status === "number" ? avr.status : null;
      const served = status !== null && status >= 100 && status < 500;
      if (!served) {
        return { shippable: false, reason: "app_verify_missing" };
      }
    }
    if (env.diagnosis !== undefined) {
      const diag = asRecord(env.diagnosis);
      const rootCauseSymbol =
        typeof diag.root_cause_symbol === "string" ? diag.root_cause_symbol.trim() : "";
      if (
        BLOCK_ON_MOCKED_SUSPECT &&
        rootCauseSymbol.length > 0 &&
        diffMocksModule(env.files, rootCauseSymbol)
      ) {
        return { shippable: false, reason: "mocked_suspect" };
      }
      const reproduced = diag.reproduced === true;
      const hasReason =
        typeof diag.not_reproduced_reason === "string" &&
        diag.not_reproduced_reason.trim().length > 0;
      if (BLOCK_ON_UNVERIFIED_DIAGNOSIS && !reproduced && !hasReason) {
        return { shippable: false, reason: "diagnosis_unreproduced" };
      }
    }
    if (BLOCK_ON_CARRIED_CONSTANT && unjustifiedCarriedConstants(env).length > 0) {
      return { shippable: false, reason: "carried_constant_unjustified" };
    }
    const ranAnyTests =
      verifyStatus !== null
        ? verifyStatus === "passed"
        : (typeof passed === "number" && passed > 0) ||
          (typeof failed === "number" && failed > 0);
    if (!ranAnyTests) {
      if (BLOCK_ON_MISSING_TESTS) {
        return { shippable: false, reason: "tests_missing" };
      }
      return {
        shippable: true,
        tests_warning: "tests_missing",
        ...wiringWarn,
      };
    }
  }

  return { shippable: true, ...wiringWarn };
}

const NO_DIFF_REASONS: ReadonlySet<ShipBlockReason> = new Set([
  "refused_envelope",
  "prose_fallback",
]);

export function isNoDiffReason(reason: ShipBlockReason): boolean {
  return NO_DIFF_REASONS.has(reason);
}

export function collectVerificationNotes(envelope: unknown): string[] {
  const env = asRecord(envelope);
  const notes: string[] = [];

  const riskClass =
    typeof env.risk_class === "string" ? env.risk_class : undefined;
  const presentsAsProposal =
    env.test_results !== undefined || env.risk_class !== undefined;
  const { passed, failed } = readTestCounts(env);
  const verifyStatus = readVerifyStatus(env);

  if (verifyStatus === "failed") {
    const detail = typeof failed === "number" && failed > 0 ? ` (${failed} failing)` : "";
    notes.push(
      `Tests: the sandbox test run FAILED${detail} — this is the real \`run_tests\` exit code, not the model's self-report. Review/fix before merge.`,
    );
  } else if (verifyStatus === "couldnt_run") {
    notes.push(
      "Tests: the sandbox could not run the test suite — nothing was verified. Review before merge.",
    );
  } else if (verifyStatus === null && typeof failed === "number" && failed > 0) {
    notes.push(
      `Tests: ${failed} failing${typeof passed === "number" ? ` (${passed} passing)` : ""} in the sandbox run (self-reported) — review/fix before merge.`,
    );
  } else if (riskClass !== "trivial" && presentsAsProposal) {
    const ranAny =
      verifyStatus !== null
        ? verifyStatus === "passed"
        : (typeof passed === "number" && passed > 0) ||
          (typeof failed === "number" && failed > 0);
    if (!ranAny) {
      notes.push(
        "Tests: no test run completed in the sandbox — please run the suite before merge.",
      );
    }
  }

  const tcv = asRecord(env.typecheck_verify);
  const tcvStatus = typeof tcv.status === "string" ? tcv.status : undefined;
  if (tcvStatus === "failed") {
    const count = typeof tcv.error_count === "number" ? tcv.error_count : 0;
    const errs = Array.isArray(tcv.errors)
      ? (tcv.errors as unknown[]).filter((e): e is string => typeof e === "string").slice(0, 3)
      : [];
    const cmd =
      typeof tcv.command === "string" ? ` (\`${tcv.command.replace(/`/g, "'").slice(0, 200)}\`)` : "";
    notes.push(
      `Typecheck${cmd}: FAILED in the sandbox${count > 0 ? ` with ${count} error${count === 1 ? "" : "s"}` : ""}. This is the real exit code, not the model's self-report. Fix before merge.` +
        errs.map((e) => `\n  - \`${e.replace(/`/g, "'")}\``).join(""),
    );
  } else if (tcvStatus !== "passed" && env.typecheck_ok === false) {
    notes.push(
      "Typecheck (`tsc --noEmit`): failed in the sandbox — likely a type or import error; verify before merge.",
    );
  }

  if (env.http_route_changed === true) {
    const avr = asRecord(env.app_verify_result);
    const status = typeof avr.status === "number" ? avr.status : null;
    if (status === null) {
      notes.push(
        "Runtime route check (app_verify): could not run in the sandbox — this repo's app likely needs a database / secrets / env to boot, so the changed route was not auto-smoke-tested. Please exercise the route manually or rely on the repo's CI.",
      );
    } else if (status >= 500) {
      notes.push(
        `Runtime route check (app_verify): the changed route returned HTTP ${status} when booted in the sandbox — confirm it serves correctly before merge.`,
      );
    }
  }

  if (env.wiring_unverified === true) {
    const syms = Array.isArray(env.wiring_unwired_symbols)
      ? (env.wiring_unwired_symbols as unknown[])
          .filter((s) => typeof s === "string")
          .slice(0, 10)
          .map((s) => `\`${s as string}\``)
      : [];
    notes.push(
      `Wiring: newly-exported symbol(s)${syms.length ? " " + syms.join(", ") : ""} have no reference outside their own file and no registration edit in this diff — confirm they're reached (or registered dynamically).`,
    );
  }

  if (
    Array.isArray(env.stale_committed_dist) &&
    env.stale_committed_dist.length > 0
  ) {
    const pkgs = (env.stale_committed_dist as unknown[])
      .map((h) => asRecord(h).pkgRoot)
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .slice(0, 10)
      .map((p) => `\`${p}\``);
    const where = pkgs.length ? pkgs.join(", ") : "a package";
    notes.push(
      `Committed dist: source changed in ${where} but its committed \`dist/\` was NOT regenerated in this diff. If this repo deploys the committed \`dist/\` without a build step, this change won't take effect until \`dist/\` is rebuilt.`,
    );
  }

  if (env.diagnosis !== undefined) {
    const diag = asRecord(env.diagnosis);
    const rootCauseSymbol =
      typeof diag.root_cause_symbol === "string" ? diag.root_cause_symbol.trim() : "";
    if (rootCauseSymbol.length > 0 && diffMocksModule(env.files, rootCauseSymbol)) {
      notes.push(
        `Diagnosis: the test mocks \`${rootCauseSymbol}\`, the dependency the root cause blames — a passing test can't prove the bug or the fix. Verify against the real dependency (or its installed source) before merge.`,
      );
    } else {
      const reproduced = diag.reproduced === true;
      const reason =
        typeof diag.not_reproduced_reason === "string" ? diag.not_reproduced_reason.trim() : "";
      if (!reproduced && reason.length > 0) {
        notes.push(
          `Diagnosis: the symptom was NOT reproduced in the sandbox (${reason.slice(0, 200)}). The fix is unverified — confirm it resolves the reported problem before merge.`,
        );
      } else if (!reproduced) {
        notes.push(
          "Diagnosis: this bugfix was not shown to reproduce the original symptom, and no reason was given for why it couldn't be reproduced. Confirm it actually fixes the reported problem before merge.",
        );
      }
    }
  } else if (
    hasCausalFixLanguage(env) &&
    presentsAsProposal &&
    riskClass !== "trivial"
  ) {
    notes.push(
      "Diagnosis: this reads like a bug fix (it describes a root cause) but carried no structured diagnosis, so I can't confirm the symptom was reproduced or that the test doesn't mock the blamed code. Sanity-check the fix actually reproduces + resolves the issue before merge.",
    );
  }

  for (const c of unjustifiedCarriedConstants(env).slice(0, 5)) {
    notes.push(
      `Carried constant: \`${c.name}\` is copied verbatim from \`${c.source_path}\`, and this PR never says why that value still holds for its new purpose. Constants carry the invariants of the code they came FROM — re-read the original's intent (and its comment) before trusting it here.`,
    );
  }

  const unasserted = detectUnassertedMocks(env.files).slice(0, 5);
  for (const p of unasserted) {
    notes.push(
      `Tests prove nothing: \`${p}\` mocks its dependencies but never asserts what any mock was CALLED WITH (no \`toHaveBeenCalledWith\` / \`.mock.calls\`). These tests prove the code ran, not that it passed the right values — the exact shape in which a green suite certifies a hole. Assert the arguments.`,
    );
  }

  return notes;
}

export type PrAudience = "zavi_built" | "customer";

export function customerVerificationNotes(envelope: unknown): string[] {
  const env = asRecord(envelope);
  if (readVerifyStatus(env) !== "failed") return [];
  const attr = asRecord(env.test_attribution);
  if (attr.kind !== "attributed" || !Array.isArray(attr.new_failures)) return [];
  const names = (attr.new_failures as unknown[]).filter(
    (n): n is string => typeof n === "string" && n.trim().length > 0,
  );
  if (names.length === 0) return [];
  const code = (s: string) => `\`${s.replace(/`/g, "'").slice(0, 200)}\``;
  const base =
    typeof env.base_branch === "string" && env.base_branch.trim()
      ? code(env.base_branch.trim())
      : "the base branch";
  const list = names.slice(0, 3).map(code).join(", ");
  const more = names.length > 3 ? ` (+${names.length - 3} more)` : "";
  return [
    names.length === 1
      ? `Tests: this change breaks ${list}${more}, which passes on ${base} when tested in the sandbox. Fix before merge.`
      : `Tests: this change breaks ${names.length} tests: ${list}${more}. They pass on ${base} when tested in the sandbox. Fix before merge.`,
  ];
}

const TESTING_SECTION_INTRO: Record<PrAudience, string> = {
  zavi_built:
    "_Automated checks that did not fully pass or could not run in the sandbox. The PR is opened anyway so you can review — please confirm these before merge:_",
  customer: "_Zavi found a problem this change causes:_",
};

export function buildTestingSection(
  notes: string[],
  audience: PrAudience = "zavi_built",
): string {
  if (!notes.length) return "";
  return [
    "## Testing & verification",
    "",
    TESTING_SECTION_INTRO[audience],
    "",
    ...notes.map((n) => `- ${n}`),
  ].join("\n");
}

export function appendTestingSection(
  body: unknown,
  notes: string[],
  maxChars = 8000,
  audience: PrAudience = "zavi_built",
): string {
  let base = typeof body === "string" ? body.trimEnd() : "";
  const section = buildTestingSection(notes, audience);
  if (!section) return base.length > maxChars ? base.slice(0, maxChars) : base;
  if (section.length >= maxChars) return section.slice(0, maxChars - 1) + "…";
  const sep = "\n\n";
  const budgetForBase = maxChars - section.length - sep.length;
  if (budgetForBase <= 0) return section;
  if (base.length > budgetForBase) {
    base = base.slice(0, Math.max(0, budgetForBase - 1)).trimEnd() + "…";
  }
  return base ? `${base}${sep}${section}` : section;
}

export function shipBlockExplanation(reason: ShipBlockReason): string {
  switch (reason) {
    case "refused_envelope":
      return "I looked into this but I'm not staging a PR (no code change was proposed).";
    case "prose_fallback":
      return "I looked into this but I'm not staging a PR (I answered in prose, there's no diff to ship).";
    case "tests_failed":
      return "I'm not staging a PR — the test run came back red. I won't ship a change with failing tests; fix the failures (or tell me to) before re-running.";
    case "tests_failed_new":
      return "I'm not staging a PR — my change broke a test that was passing on the base branch. That's on me, not on your repo; let me fix it before this ships.";
    case "typecheck_failed":
      return "I'm not staging a PR — `tsc --noEmit` came back red. I won't ship a change that doesn't typecheck (often a broken or missing import / unregistered symbol); fix the type errors before re-running.";
    case "tests_missing":
      return "I'm not staging a PR — this code change shipped without a passing test run, and the missing-tests gate is enforced. Add/run tests before re-running.";
    case "wiring_unverified_block":
      return "I'm not staging a PR — the wiring check found a newly-exported symbol with no references outside its own file and no registration edit in this diff (a likely-unwired handler/route/node). Add the router/registry/index/barrel edit that reaches it (or, if it's registered dynamically, say so in the PR body under \"### Wiring\") and re-run.";
    case "app_verify_missing":
      return "I'm not staging a PR — this diff changes a request handler/route but carries no app_verify result showing the running app served the path with a non-5xx status. After tests are green, run app_verify on the changed path and emit app_verify_result: { path, status }, then re-run. (Pure non-HTTP or risk_class:trivial changes are exempt.)";
    case "mocked_suspect":
      return "I'm not auto-merging this — the test mocks the very dependency my root cause blames, so a green test can't actually prove the bug or the fix (that's exactly how a confident no-op ships). Test against the real dependency, or read its installed source to confirm the root cause, then re-run.";
    case "carried_constant_unjustified":
      return "I'm not auto-merging this — it copies a distinctive constant out of another file without saying why that value still holds here. A constant carries the invariants of the code it came FROM; when those don't survive the copy you get a silent defect that every test still passes (a \"no logos\" suffix on a logo generator). Add a `carried_constant_notes` entry naming the constant, its source, and why it still holds — or stop carrying it — then re-run.";
    case "diagnosis_unreproduced":
      return "I'm not auto-merging this — it's a bugfix but I never reproduced the symptom (no failing test/log the fix makes pass) and I didn't record why it couldn't be reproduced. A fix for a bug I never reproduced is an unverified diagnosis — reproduce it first, or say why you can't (not_reproduced_reason), then re-run.";
    case "design_fidelity":
      return "I'm not staging a PR — I built a native browser control (a default date/time input or a bare dropdown) that the design you approved didn't call for. You approved a custom component and I quietly substituted the browser's default, which is not the thing you said yes to. Let me rebuild it to the approved mock — or, if that component genuinely can't be built cheaply here, I'll tell you why and we can re-preview.";
  }
}

export function buildShipBlockBody(
  reason: ShipBlockReason,
  opts?: {
    rendered_markdown?: string;
    wiring_unwired_symbols?: string[];
  },
): string {
  const explanation = shipBlockExplanation(reason);
  const diagnosis =
    typeof opts?.rendered_markdown === "string"
      ? opts.rendered_markdown.trim()
      : "";

  const parts: string[] = [];
  if (diagnosis) parts.push(diagnosis);
  parts.push(explanation);

  if (reason === "wiring_unverified_block") {
    const syms = Array.isArray(opts?.wiring_unwired_symbols)
      ? opts!.wiring_unwired_symbols.filter((s) => typeof s === "string").slice(0, 10)
      : [];
    if (syms.length > 0) {
      parts.push("Unwired symbol(s): " + syms.map((s) => `\`${s}\``).join(", "));
    }
  }

  return parts.join("\n\n");
}
