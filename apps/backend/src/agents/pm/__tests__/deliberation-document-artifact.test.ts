
import { describe, it, expect, vi, beforeEach } from "vitest";

const captureCall = vi.fn();
let responseQueue: Array<unknown | Error> = [];

vi.mock("@/services/anthropic", async () => {
  const actual =
    await vi.importActual<typeof import("@/services/anthropic")>("@/services/anthropic");
  return {
    ...actual,
    getAnthropic: () => ({
      messages: {
        create: async (...args: unknown[]) => {
          captureCall(...args);
          const next = responseQueue.shift();
          if (next instanceof Error) throw next;
          return next;
        },
      },
    }),
  };
});

const criticCalls: Array<{ mode: string }> = [];
vi.mock("../critic", async () => {
  const actual = await vi.importActual<typeof import("../critic")>("../critic");
  return {
    ...actual,
    runPmDeliberationCritic: vi.fn(async (_draft: unknown, mode: string) => {
      criticCalls.push({ mode });
      return {
        verdict: "revise" as const,
        findings: [
          {
            kind: "unsupported_claim",
            detail: "Asserts the two products share no infrastructure with nothing cited.",
          },
        ],
      };
    }),
  };
});

import { deliberatePmEnvelope } from "../deliberation";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

const ctx = {
  tenant_id: "11111111-1111-1111-1111-111111111111",
  runId: "run_pm_doc_1",
} as unknown as AgentContext;

function makeResult(parsed: unknown): DispatcherResult {
  return {
    output_text: "ORIGINAL_OUTPUT",
    parsed,
    parse_ok: true,
  } as unknown as DispatcherResult;
}

const LONG_BODY = `## Executive summary\n${"This plan describes the referral program in detail. ".repeat(20)}`;

function documentBrief(over: Record<string, unknown> = {}) {
  return {
    status: "no_signal" as const,
    rendered_markdown: LONG_BODY,
    artifact_label: "Host Referral Program Plan v1",
    summary: { bullets: [] as string[] },
    backlog: [] as unknown[],
    dispatched_actions: [] as unknown[],
    recommended_actions_not_dispatched: [] as unknown[],
    sources_all: [] as unknown[],
    ...over,
  };
}

function textResponse(obj: unknown): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(obj) }],
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

beforeEach(() => {
  captureCall.mockReset();
  criticCalls.length = 0;
  responseQueue = [];
});

describe("deliberatePmEnvelope — document artifacts", () => {
  it("(1) a no_signal turn carrying artifact_label IS deliberated (was a silent no-op)", async () => {
    const result = makeResult(documentBrief());
    responseQueue = [
      textResponse({
        ...documentBrief(),
        rendered_markdown: `${LONG_BODY}\n\nCorrected: billing lives in the other repo.`,
      }),
    ];

    await deliberatePmEnvelope(ctx, result);

    expect(criticCalls.length).toBe(1);
  });

  it("(2) a bare no_signal refusal is still a no-op (shaping preserved)", async () => {
    const result = makeResult(
      documentBrief({ artifact_label: null, rendered_markdown: "No signal this week." }),
    );

    await deliberatePmEnvelope(ctx, result);

    expect(criticCalls.length).toBe(0);
    expect(result.parsed).toMatchObject({ status: "no_signal" });
  });

  it("(3) the critic runs in 'document' mode, NOT 'delivery' — this is what arms the cross-family lane", async () => {
    const result = makeResult(documentBrief());
    responseQueue = [textResponse(documentBrief())];

    await deliberatePmEnvelope(ctx, result);

    expect(criticCalls[0]?.mode).toBe("document");
    expect(criticCalls[0]?.mode).not.toBe("delivery");
  });

  it("(4) the document revise pass gets the document prompt and a budget big enough to re-emit the body", async () => {
    const result = makeResult(documentBrief());
    responseQueue = [textResponse(documentBrief())];

    await deliberatePmEnvelope(ctx, result);

    const reviseArgs = captureCall.mock.calls.at(-1)?.[0] as {
      system: string;
      max_tokens: number;
    };
    expect(reviseArgs.system).toContain("rendered_markdown");
    expect(reviseArgs.max_tokens).toBeGreaterThan(3000);
  });

  it("(5) a revised document body replaces the original envelope", async () => {
    const result = makeResult(documentBrief());
    const corrected = documentBrief({
      rendered_markdown: `${LONG_BODY}\n\nBilling lives in the main repo, verified.`,
    });
    responseQueue = [textResponse(corrected)];

    await deliberatePmEnvelope(ctx, result);

    expect((result.parsed as { rendered_markdown: string }).rendered_markdown).toContain(
      "verified",
    );
  });
});
