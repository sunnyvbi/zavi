import { describe, it, expect, vi } from "vitest";

vi.mock("../../client", () => ({
  inngest: { createFunction: (_cfg: unknown, _trigger: unknown, handler: unknown) => ({ handler }) },
}));

import {
  runBrainJudgeScan,
  gateFor,
  type DraftRow,
  type BrainJudgeDeps,
} from "../brain-judge-scan";
import type { JudgeVerdict } from "@/services/readiness/judge-draft";

function deps(over: Partial<BrainJudgeDeps> = {}): BrainJudgeDeps & {
  promoted: string[];
  recomputed: string[];
} {
  const promoted: string[] = [];
  const recomputed: string[] = [];
  return {
    promoted,
    recomputed,
    judge: async () => ({ verdict: "promote", reason: "backed", unsupported_claims: [] }) as JudgeVerdict,
    promote: (async (p: { tenant_id: string; slug: string }) => {
      promoted.push(`${p.tenant_id}:${p.slug}`);
      return { ok: true as const, slug: p.slug as never, note_id: "n1", forced: false };
    }) as unknown as BrainJudgeDeps["promote"],
    recompute: async (t: string) => {
      recomputed.push(t);
    },
    log: (async () => {}) as unknown as BrainJudgeDeps["log"],
    ...over,
  };
}

const row = (over: Partial<DraftRow> & { tenant_id: string; slug: string }): DraftRow => ({
  body_markdown: "flat $60 fee",
  metadata: { discovery: { cited_sources: [{ url: "https://acme.co", note: "$60 fee" }] } },
  ...over,
});

describe("gateFor — kill switch + pilot allowlist", () => {
  it("defaults ON fleet-wide when config is absent", () => {
    expect(gateFor({})).toEqual({ enabled: true, allowlist: [] });
  });
  it("kills fleet-wide on explicit false", () => {
    expect(gateFor({ brain_judge_autopromote_enabled: false }).enabled).toBe(false);
  });
  it("restricts to a non-empty pilot allowlist", () => {
    expect(gateFor({ brain_judge_autopromote_tenants: ["t-1"] })).toEqual({
      enabled: true,
      allowlist: ["t-1"],
    });
  });
});

describe("runBrainJudgeScan", () => {
  it("promotes a draft the judge passes, via:'judge', and recomputes that tenant once", async () => {
    const d = deps();
    const promoteSpy = vi.fn(d.promote);
    const res = await runBrainJudgeScan([row({ tenant_id: "t-1", slug: "policies__inferred" })], {
      ...d,
      promote: promoteSpy as never,
    });
    expect(res.promoted).toBe(1);
    expect(res.held).toBe(0);
    expect(promoteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: "t-1", slug: "policies", via: "judge" }),
    );
    expect(d.recomputed).toEqual(["t-1"]);
  });

  it("holds a draft the judge rejects — no promote, no recompute", async () => {
    const d = deps({
      judge: async () => ({ verdict: "hold", reason: "unsourced $99", unsupported_claims: ["$99"] }),
    });
    const res = await runBrainJudgeScan([row({ tenant_id: "t-2", slug: "policies__inferred" })], d);
    expect(res.promoted).toBe(0);
    expect(res.held).toBe(1);
    expect(d.promoted).toEqual([]);
    expect(d.recomputed).toEqual([]);
  });

  it("skips a draft whose base slug is not a scored canonical anchor — no model call", async () => {
    let judged = 0;
    const d = deps({
      judge: async () => {
        judged++;
        return { verdict: "promote", reason: "x", unsupported_claims: [] };
      },
    });
    const res = await runBrainJudgeScan([row({ tenant_id: "t-3", slug: "random_topic__inferred" })], d);
    expect(res.skipped_noncanonical).toBe(1);
    expect(res.judged).toBe(0);
    expect(judged).toBe(0);
  });

  it("a protected-anchor refusal counts as held, not promoted", async () => {
    const d = deps({
      promote: (async () => ({
        ok: false as const,
        code: "protected_anchor" as const,
        message: "held by a human",
        existing_source: "human",
      })) as unknown as BrainJudgeDeps["promote"],
    });
    const res = await runBrainJudgeScan([row({ tenant_id: "t-4", slug: "company__inferred" })], d);
    expect(res.promoted).toBe(0);
    expect(res.held).toBe(1);
    expect(d.recomputed).toEqual([]);
  });

  it("a render failure counts as an error, not held", async () => {
    const d = deps({
      promote: (async () => ({
        ok: false as const,
        code: "render_failed" as const,
        message: "the brief could not be rebuilt",
        existing_source: "unknown",
      })) as unknown as BrainJudgeDeps["promote"],
    });
    const res = await runBrainJudgeScan([row({ tenant_id: "t-5", slug: "company__inferred" })], d);
    expect(res.errors).toBe(1);
    expect(res.held).toBe(0);
    expect(res.promoted).toBe(0);
  });

  it("isolates a throwing draft — the batch keeps going, error is counted not fatal", async () => {
    let n = 0;
    const d = deps({
      judge: async () => {
        n++;
        if (n === 1) throw new Error("judge exploded");
        return { verdict: "promote", reason: "ok", unsupported_claims: [] };
      },
    });
    const res = await runBrainJudgeScan(
      [
        row({ tenant_id: "t-a", slug: "policies__inferred" }),
        row({ tenant_id: "t-b", slug: "company__inferred" }),
      ],
      d,
    );
    expect(res.errors).toBe(1);
    expect(res.promoted).toBe(1);
    expect(d.recomputed).toEqual(["t-b"]);
  });

  it("recomputes each touched tenant only ONCE even with multiple promoted anchors", async () => {
    const d = deps();
    const res = await runBrainJudgeScan(
      [
        row({ tenant_id: "t-5", slug: "policies__inferred" }),
        row({ tenant_id: "t-5", slug: "company__inferred" }),
      ],
      d,
    );
    expect(res.promoted).toBe(2);
    expect(d.recomputed).toEqual(["t-5"]);
  });
});
