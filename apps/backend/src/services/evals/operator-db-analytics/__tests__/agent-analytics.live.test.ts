
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", async () => (await import("../harness/mocks")).supabaseMock());
vi.mock("@/services/tenant-client", async () => (await import("../harness/mocks")).tenantClientMock());
vi.mock("@/services/secrets/vault", async () => (await import("../harness/mocks")).vaultMock());
vi.mock("@/services/logging/logEvent", async () => (await import("../harness/mocks")).logEventMock());
vi.mock("@/services/sandbox/codeact-sandbox", async (orig) => ({
  ...((await orig()) as object),
  ...(await import("../harness/mocks")).codeactSandboxMock(),
}));

import { configuredDialects, type EvalDialect } from "../env";
import { askAgent } from "../harness/agent-loop";
import { installEvalTenant } from "../harness/eval-tenant";
import { gradeNumeric, judgeNarrative, summarise, type Verdict } from "../harness/grade";
import { ALL_SHAPES, questionsFor } from "../questions";
import { writeReport } from "../harness/report";

const DIALECTS = configuredDialects();
const live = DIALECTS.length > 0 && process.env.EVAL_OPDB_AGENT === "1";

const dialect: EvalDialect =
  (process.env.EVAL_OPDB_DIALECT as EvalDialect | undefined) ?? DIALECTS[0] ?? "postgres";
const shapes = (process.env.EVAL_OPDB_SHAPES?.split(",").map((s) => s.trim()).filter(Boolean) ??
  ALL_SHAPES);
const onlyQuestions = new Set(
  process.env.EVAL_OPDB_QUESTIONS?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) ?? [],
);

const verdicts: Verdict[] = [];

describe.skipIf(!live)(`operator-db analytics — agent (${dialect})`, () => {
  beforeAll(() => {
    console.log(`[eval] agent layer: dialect=${dialect} shapes=${shapes.join(",")}`);
  });

  afterAll(async () => {
    if (verdicts.length === 0) return;
    const summary = summarise(verdicts);
    console.log(
      `\n[eval] ${summary.passed}/${summary.total} correct (${(summary.accuracy * 100).toFixed(1)}%)`,
    );
    await writeReport({ dialect, verdicts, summary });
  });

  for (const shape of shapes) {
    const { dataset, questions } = questionsFor(shape);
    for (const q of questions) {
      if (onlyQuestions.size > 0 && !onlyQuestions.has(q.id)) continue;
      it(
        `${shape}/${q.id} [${q.traps.join(",")}] ${q.prompt.slice(0, 60)}...`,
        async () => {
          await installEvalTenant(dialect, shape);
          const turn = await askAgent(q.prompt, dataset);
          const verdict =
            q.kind === "numeric"
              ? gradeNumeric(q, turn.answer, turn.toolCalls)
              : await judgeNarrative(q, turn.answer, turn.toolCalls);
          verdicts.push(verdict);

          expect(
            verdict.pass,
            [
              `${q.id} failed: ${verdict.failure_mode ?? "?"}`,
              verdict.diagnosed_mistake ? `mistake: ${verdict.diagnosed_mistake}` : "",
              `expected ${verdict.expected} got ${verdict.got}`,
              `tools: ${verdict.tool_calls} (${verdict.failed_tool_calls} failed)`,
              verdict.notes ? `notes: ${verdict.notes}` : "",
            ]
              .filter(Boolean)
              .join(" | "),
          ).toBe(true);
        },
        180_000,
      );
    }
  }
});
