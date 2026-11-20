
import { describe, it, expect, vi, beforeEach } from "vitest";

const { writeNoteMock } = vi.hoisted(() => ({ writeNoteMock: vi.fn() }));
vi.mock("@/services/memory", () => ({ writeNote: writeNoteMock }));

const { flagMock } = vi.hoisted(() => ({ flagMock: vi.fn(async () => false) }));
vi.mock("../typed-digest-flag", () => ({
  isPerfmktTypedDigestEnabled: flagMock,
}));

import { adsManagerPostProcess } from "../post-run";
import type { PostProcessorFn } from "@/agents/index";

function makeCtx() {
  const emitDecision = vi.fn(() => {
    throw new Error("performance-marketer is digest_only — must NOT emit a decision");
  });
  const ctx = {
    tenant_id: "t-1",
    runId: "r-1",
    trigger: "cron",
    emitDecision,
  } as unknown as Parameters<PostProcessorFn>[0];
  return { ctx, emitDecision };
}

const PROSE_RENDERED = [
  "## performance-marketer weekly plan",
  "",
  "### Weekly summary",
  "REGEX-SUMMARY: spend held flat week over week.",
  "",
  "### Proposed reallocation",
  "REGEX-REALLOC: move $40/wk from meta to google.",
  "",
  "### So-what + trend",
  "REGEX-SOWHAT: CAC trending down for three weeks.",
].join("\n");

const TYPED_SECTIONS = {
  weekly_summary: "TYPED-SUMMARY: spend up 10% on google.",
  anomalies: "TYPED-ANOMALY: CTR dipped Tuesday.",
  proposed_reallocation: "TYPED-REALLOC: shift $60/wk meta to google.",
  new_tests: "TYPED-TESTS: trial a lookalike audience.",
  risks: "TYPED-RISK: frequency creeping past 3.",
  so_what_trend: "TYPED-SOWHAT: ROAS improving, payback in 18 days.",
};

function makeResult(parsed: Record<string, unknown>) {
  return {
    parse_ok: true,
    parsed,
  } as unknown as Parameters<PostProcessorFn>[1];
}

function notesWritten() {
  return writeNoteMock.mock.calls.map((c) => ({
    tenant: c[0] as string,
    note: c[1] as {
      note_type: string;
      title: string;
      body_markdown: string;
      tags?: string[];
    },
  }));
}

beforeEach(() => {
  writeNoteMock.mockReset();
  writeNoteMock.mockResolvedValue(undefined);
  flagMock.mockReset();
  flagMock.mockResolvedValue(false);
});

describe("adsManagerPostProcess — perfmkt-typed-digest", () => {
  it("flag OFF → regex path (typed fields ignored even when present)", async () => {
    flagMock.mockResolvedValue(false);
    const { ctx, emitDecision } = makeCtx();
    await adsManagerPostProcess(
      ctx,
      makeResult({
        rendered_markdown: PROSE_RENDERED,
        digest_sections: TYPED_SECTIONS,
      }),
      {},
    );
    const [{ note }] = notesWritten();
    expect(note.note_type).toBe("ads_channel_perf");
    expect(note.body_markdown).toContain("REGEX-SUMMARY");
    expect(note.body_markdown).toContain("REGEX-REALLOC");
    expect(note.body_markdown).toContain("REGEX-SOWHAT");
    expect(note.body_markdown).not.toContain("TYPED-");
    expect(emitDecision).not.toHaveBeenCalled();
  });

  it("flag ON + digest_sections present → note body uses TYPED content", async () => {
    flagMock.mockResolvedValue(true);
    const { ctx, emitDecision } = makeCtx();
    await adsManagerPostProcess(
      ctx,
      makeResult({
        rendered_markdown: PROSE_RENDERED,
        digest_sections: TYPED_SECTIONS,
      }),
      {},
    );
    const [{ note }] = notesWritten();
    expect(note.note_type).toBe("ads_channel_perf");
    expect(note.body_markdown).toContain("TYPED-SUMMARY");
    expect(note.body_markdown).toContain("TYPED-REALLOC");
    expect(note.body_markdown).toContain("TYPED-SOWHAT");
    expect(note.body_markdown).not.toContain("REGEX-");
    expect(note.body_markdown).toContain("TYPED-ANOMALY");
    expect(note.body_markdown).toContain("TYPED-TESTS");
    expect(note.body_markdown).toContain("TYPED-RISK");
    expect(emitDecision).not.toHaveBeenCalled();
  });

  it("flag ON but digest_sections ABSENT → regex fallback", async () => {
    flagMock.mockResolvedValue(true);
    const { ctx } = makeCtx();
    await adsManagerPostProcess(
      ctx,
      makeResult({ rendered_markdown: PROSE_RENDERED }),
      {},
    );
    const [{ note }] = notesWritten();
    expect(note.body_markdown).toContain("REGEX-SUMMARY");
    expect(note.body_markdown).not.toContain("TYPED-");
  });

  it("flag ON but digest_sections incomplete (missing so_what_trend) → regex fallback", async () => {
    flagMock.mockResolvedValue(true);
    const { ctx } = makeCtx();
    await adsManagerPostProcess(
      ctx,
      makeResult({
        rendered_markdown: PROSE_RENDERED,
        digest_sections: {
          weekly_summary: TYPED_SECTIONS.weekly_summary,
          proposed_reallocation: TYPED_SECTIONS.proposed_reallocation,
        },
      }),
      {},
    );
    const [{ note }] = notesWritten();
    expect(note.body_markdown).toContain("REGEX-SOWHAT");
    expect(note.body_markdown).not.toContain("TYPED-SUMMARY");
  });

  it("flag ON but digest_sections empty {} → regex fallback", async () => {
    flagMock.mockResolvedValue(true);
    const { ctx } = makeCtx();
    await adsManagerPostProcess(
      ctx,
      makeResult({ rendered_markdown: PROSE_RENDERED, digest_sections: {} }),
      {},
    );
    const [{ note }] = notesWritten();
    expect(note.body_markdown).toContain("REGEX-SUMMARY");
    expect(note.body_markdown).not.toContain("TYPED-");
  });

  it("parse_failed envelope → no-op (no note, never reads flag)", async () => {
    const { ctx } = makeCtx();
    await adsManagerPostProcess(
      ctx,
      { parse_ok: false, parsed: null } as unknown as Parameters<PostProcessorFn>[1],
      {},
    );
    expect(writeNoteMock).not.toHaveBeenCalled();
    expect(flagMock).not.toHaveBeenCalled();
  });

  it("writeNote is called with the right note_type + tags (both paths)", async () => {
    flagMock.mockResolvedValue(true);
    const { ctx } = makeCtx();
    await adsManagerPostProcess(
      ctx,
      makeResult({
        rendered_markdown: PROSE_RENDERED,
        digest_sections: TYPED_SECTIONS,
      }),
      {},
    );
    expect(writeNoteMock).toHaveBeenCalledTimes(1);
    const [tenant, note] = writeNoteMock.mock.calls[0];
    expect(tenant).toBe("t-1");
    expect(note.note_type).toBe("ads_channel_perf");
    expect(note.source).toBe("agent_run");
    expect(note.source_ref).toBe("r-1");
    expect(note.tags).toContain("source-agent:performance-marketer");
    expect(note.tags).toContain("growth-fan-in");
  });
});
