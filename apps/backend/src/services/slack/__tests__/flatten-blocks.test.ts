
import { describe, it, expect } from "vitest";
import { flattenSlackBlocks, hasStructuralBlocks } from "../flatten-blocks";

const APPROVAL_CARD_BLOCKS = [
  {
    type: "header",
    text: { type: "plain_text", text: "Hand work to a specialist agent", emoji: true },
  },
  {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "✅ *Approve* → Hands the work to the specialist agent to start on.\n🚫 *Reject* → The specialist agent is not dispatched.",
      },
    ],
  },
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "Process refund for Trip 16352 — $1,388 charge on guest Justin (userId 1009040, charge ch_3TsdgILKcPR2aUso0TyO2TZX) was not reversed after admin cancellation on Jul 13. Confirm eligibility and issue refund.",
    },
  },
  {
    type: "section",
    fields: [{ type: "mrkdwn", text: "*Target agent*\nsupport-lead" }],
  },
  {
    type: "actions",
    elements: [
      { type: "button", text: { type: "plain_text", text: "Approve" }, value: "approve" },
      { type: "button", text: { type: "plain_text", text: "Reject" }, value: "reject" },
    ],
  },
];

describe("flattenSlackBlocks", () => {
  it("recovers the approval-card proposal body + target agent from blocks", () => {
    const out = flattenSlackBlocks(APPROVAL_CARD_BLOCKS);
    expect(out).toContain("Process refund for Trip 16352");
    expect(out).toContain("$1,388");
    expect(out).toContain("ch_3TsdgILKcPR2aUso0TyO2TZX");
    expect(out).toContain("support-lead");
    expect(out).toContain("Target agent");
    expect(out).toContain("Hand work to a specialist agent");
  });

  it("does NOT surface interactive button labels as prose", () => {
    const out = flattenSlackBlocks(APPROVAL_CARD_BLOCKS);
    const withoutActions = flattenSlackBlocks(APPROVAL_CARD_BLOCKS.slice(0, 4));
    expect(out).toBe(withoutActions);
  });

  it("flattens rich_text nested elements", () => {
    const blocks = [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "text", text: "hello " },
              { type: "text", text: "world" },
            ],
          },
        ],
      },
    ];
    expect(flattenSlackBlocks(blocks)).toContain("hello world");
  });

  it("flattens attachments text and nested blocks", () => {
    const out = flattenSlackBlocks(undefined, [
      { text: "legacy attachment body" },
      {
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "nested attachment block" } }],
      },
    ]);
    expect(out).toContain("legacy attachment body");
    expect(out).toContain("nested attachment block");
  });

  it("returns empty string for no renderable content (caller falls back to text)", () => {
    expect(flattenSlackBlocks(undefined)).toBe("");
    expect(flattenSlackBlocks([])).toBe("");
    expect(flattenSlackBlocks([{ type: "divider" }, { type: "image", image_url: "x" }])).toBe("");
  });

  it("never throws on malformed payloads", () => {
    expect(flattenSlackBlocks("not-an-array" as unknown)).toBe("");
    expect(flattenSlackBlocks([null, 42, { type: "section" }, { type: "section", text: null }] as unknown)).toBe("");
    expect(flattenSlackBlocks({ nope: true } as unknown)).toBe("");
  });

  it("a malformed block does NOT abort the valid blocks after it (per-item guard)", () => {
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "BEFORE" } },
      null,
      42,
      { type: "section", text: { type: "mrkdwn", text: "AFTER" } },
    ];
    const out = flattenSlackBlocks(blocks as unknown);
    expect(out).toContain("BEFORE");
    expect(out).toContain("AFTER");
  });

  it("bounds total length (MAX_FLAT) so a huge payload can't allocate unbounded", () => {
    const huge = Array.from({ length: 500 }, () => ({
      type: "section",
      text: { type: "mrkdwn", text: "x".repeat(1000) },
    }));
    const out = flattenSlackBlocks(huge);
    expect(out.length).toBeLessThan(12000);
  });
});

describe("hasStructuralBlocks — human rich_text vs app card discriminator", () => {
  it("false for a normal human message (rich_text-only mirror)", () => {
    expect(
      hasStructuralBlocks([
        { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "hi" }] }] },
      ]),
    ).toBe(false);
  });

  it("true for an app card (header/section blocks present)", () => {
    expect(hasStructuralBlocks(APPROVAL_CARD_BLOCKS)).toBe(true);
    expect(hasStructuralBlocks([{ type: "section", text: { type: "mrkdwn", text: "x" } }])).toBe(true);
  });

  it("false for absent / non-array blocks", () => {
    expect(hasStructuralBlocks(undefined)).toBe(false);
    expect(hasStructuralBlocks([])).toBe(false);
    expect(hasStructuralBlocks("nope" as unknown)).toBe(false);
  });
});
