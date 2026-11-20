import { describe, it, expect } from "vitest";
import {
  buildDigestBlocks,
  buildDigestFallbackText,
  DIGEST_INLINE_MAX,
  SLACK_ACTION_APPROVE,
  SLACK_ACTION_REJECT,
  SLACK_ACTION_APPROVE_ALL,
  SLACK_ACTION_REJECT_ALL,
  SLACK_BLOCK_ID_ACTIONS,
  SLACK_BLOCK_ID_BATCH,
  type DigestItem,
} from "../slack-approval-blocks";

type Block = {
  type: string;
  block_id?: string;
  text?: { text?: string };
  elements?: Array<{ action_id?: string; value?: string; url?: string; text?: { text?: string } }>;
};

const KINDS = ["recurred", "failed_to_open", "stuck", "dispatch_died"] as const;

function makeItems(n: number): DigestItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `dec-${i}`,
    theme: `Theme number ${i}`,
    exception_kind: KINDS[i % KINDS.length],
  }));
}

describe("buildDigestBlocks — ≤ DIGEST_INLINE_MAX (per-item buttons)", () => {
  const items = makeItems(3);
  const blocks = buildDigestBlocks({ runId: "run-9", items, cutoffMs: 1782636000000 }) as Block[];

  it("renders per-item Approve/Reject buttons carrying the decision_id", () => {
    const actionBlocks = blocks.filter((b) => b.type === "actions" && b.block_id === SLACK_BLOCK_ID_ACTIONS);
    expect(actionBlocks.length).toBe(3);
    for (let i = 0; i < items.length; i++) {
      const els = actionBlocks[i].elements ?? [];
      const approve = els.find((e) => e.action_id === SLACK_ACTION_APPROVE);
      const reject = els.find((e) => e.action_id === SLACK_ACTION_REJECT);
      expect(approve?.value).toBe(items[i].id);
      expect(reject?.value).toBe(items[i].id);
    }
  });

  it("includes a batch row (approve-all/reject-all) carrying run|cutoff, and NO app link", () => {
    const batch = blocks.find((b) => b.type === "actions" && b.block_id === SLACK_BLOCK_ID_BATCH)!;
    const ids = (batch.elements ?? []).map((e) => e.action_id);
    expect(ids).toContain(SLACK_ACTION_APPROVE_ALL);
    expect(ids).toContain(SLACK_ACTION_REJECT_ALL);
    expect((batch.elements ?? [])[0].value).toBe("run-9|1782636000000");
    expect((batch.elements ?? []).some((e) => !!e.url)).toBe(false);
  });

  it("renders the REAL exception_kind verbatim for every item (invariant 2)", () => {
    const s = JSON.stringify(blocks);
    for (const it of items) {
      expect(s).toContain(it.theme);
      expect(s).toContain(it.exception_kind);
    }
  });

  it("header count matches the number of items (invariant 1)", () => {
    const header = blocks.find((b) => b.type === "header")!;
    expect(header.text?.text).toContain("3 approvals");
  });
});

describe("buildDigestBlocks — > DIGEST_INLINE_MAX (summary + app link, no per-item buttons)", () => {
  const n = DIGEST_INLINE_MAX + 40;
  const items = makeItems(n);
  const blocks = buildDigestBlocks({ runId: "run-55", items, cutoffMs: 1782636000000 }) as Block[];

  it("renders NO per-item action blocks", () => {
    const perItem = blocks.filter((b) => b.type === "actions" && b.block_id === SLACK_BLOCK_ID_ACTIONS);
    expect(perItem.length).toBe(0);
  });

  it("lists EVERY item (theme + real exception_kind) with nothing silently dropped (invariant 1)", () => {
    const s = JSON.stringify(blocks);
    for (const it of items) {
      expect(s).toContain(it.theme);
    }
    expect(s).not.toMatch(/\+\d+ more/);
  });

  it("shows the real exception_kind tokens (invariant 2)", () => {
    const s = JSON.stringify(blocks);
    for (const k of KINDS) expect(s).toContain(k);
  });

  it("has a batch row + a 'Review each in the app' url link", () => {
    const batch = blocks.find((b) => b.type === "actions" && b.block_id === SLACK_BLOCK_ID_BATCH)!;
    const ids = (batch.elements ?? []).map((e) => e.action_id);
    expect(ids).toContain(SLACK_ACTION_APPROVE_ALL);
    expect(ids).toContain(SLACK_ACTION_REJECT_ALL);
    const link = (batch.elements ?? []).find((e) => !!e.url);
    expect(link).toBeTruthy();
    expect(link!.text?.text).toMatch(/app/i);
  });

  it("header count matches the total item count (invariant 1)", () => {
    const header = blocks.find((b) => b.type === "header")!;
    expect(header.text?.text).toContain(`${n} approvals`);
  });
});

describe("buildDigestBlocks — truly huge group accounts for the remainder with +N more", () => {
  const items: DigestItem[] = Array.from({ length: 400 }, (_, i) => ({
    id: `d-${i}`,
    theme: `A deliberately long roadmap theme string number ${i} `.padEnd(120, "x"),
    exception_kind: "stuck",
  }));
  const blocks = buildDigestBlocks({ runId: "run-big", items, cutoffMs: 1 }) as Block[];

  it("adds a '+N more' remainder note so no item is silently dropped", () => {
    const s = JSON.stringify(blocks);
    expect(s).toMatch(/\+\d+ more/);
  });

  it("caps list section blocks at the block budget", () => {
    const sections = blocks.filter((b) => b.type === "section");
    expect(sections.length).toBeLessThanOrEqual(6);
  });
});

describe("buildDigestFallbackText", () => {
  it("pluralizes on count", () => {
    expect(buildDigestFallbackText(1)).toBe("1 PM approval need your call");
    expect(buildDigestFallbackText(5)).toBe("5 PM approvals need your call");
  });
});
