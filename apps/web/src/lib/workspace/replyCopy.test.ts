import { describe, expect, it } from "vitest";
import { cleanCopyMarkdown, markdownToPlainText, replyCopyMarkdown, turnCopyByRow } from "./replyCopy";
import type { ChatRow } from "./useChatThread";

const ORIGIN = "https://www.zaviagent.com";

const ATLANTA = [
  "**Keep the Atlanta gig ad set as it is until its test ends Wednesday, Oct 28.** It looks worse than it is.",
  "**Why not pause Atlanta today**\n- **All 3 purchases came in the last 3 days.** From Oct 14 to 22 it spent $392.42.\n- **Your database loosely backs this up.**",
  "I set a check for **Wed, Oct 28, 7:00 PM PDT**.",
  "2 more cards are waiting on the [Growth page](/workspace?tab=growth-strategy). Channel cards: [Meta Ads · 4](/workspace?tab=channels&channel=meta_ads) [Google Ads · 4](/workspace?tab=channels&channel=google_ads) [SEO · 2](/workspace?tab=channels&channel=seo)",
].join("\n\n");
const RULE = 'Keep this as a rule? "optimize for sign-ups". You can save it in Settings → Rules.';

const row = (id: string, kind: ChatRow["kind"], text: string): ChatRow =>
  ({ id, kind, agent_run_id: null, body: { text }, citations: [], created_at: "2026-10-26T06:35:00Z" }) as ChatRow;

describe("Copy on a Zavi reply", () => {
  it("pastes the Atlanta reply as clean text: no ** marks, no channel-card tail", () => {
    const plain = markdownToPlainText(cleanCopyMarkdown(ATLANTA, ORIGIN), ORIGIN);
    expect(plain).not.toContain("**");
    expect(plain).not.toMatch(/Channel cards|workspace\?/);
    expect(plain).toContain("Keep the Atlanta gig ad set as it is until its test ends Wednesday, Oct 28. It looks worse");
    expect(plain).toContain("- All 3 purchases came in the last 3 days. From Oct 14 to 22 it spent $392.42.");
    expect(plain).toContain("I set a check for Wed, Oct 28, 7:00 PM PDT.");
  });

  it("keeps a sentence that links three channels without card counts", () => {
    const md = "Compare [Meta Ads](/workspace?a), [Google Ads](/workspace?b) and [TikTok Ads](/workspace?c): Meta has the best ROAS.";
    expect(markdownToPlainText(cleanCopyMarkdown(md, ORIGIN), ORIGIN)).toBe(
      "Compare Meta Ads, Google Ads and TikTok Ads: Meta has the best ROAS.",
    );
  });

  it("leaves inline code literal in the clean text", () => {
    expect(markdownToPlainText("Use `2 ** 3 ** 2` and `__dirname__`, **not** this.", ORIGIN)).toBe(
      "Use 2 ** 3 ** 2 and __dirname__, not this.",
    );
  });

  it("keeps one or two in-app links as full URLs in the formatted copy", () => {
    const md = cleanCopyMarkdown("See the [Growth page](/workspace?tab=growth-strategy) and [docs](https://x.com/a).", ORIGIN);
    expect(md).toBe("See the [Growth page](https://www.zaviagent.com/workspace?tab=growth-strategy) and [docs](https://x.com/a).");
    expect(markdownToPlainText(md, ORIGIN)).toBe("See the Growth page and docs (https://x.com/a).");
  });

  it("strips headings, inline code, italics and fences but keeps list markers and snake_case", () => {
    const md = "## Plan\n\n* one *now*\n2. run `npm test`\n\n```\ncode\n```\n\nkeep tier_gate_enforced as is";
    expect(markdownToPlainText(md, ORIGIN)).toBe("Plan\n\n- one now\n2. run npm test\n\ncode\n\nkeep tier_gate_enforced as is");
  });

  it("copies the whole over-cap reply, not just the stored lead, and never the Sources note", () => {
    expect(replyCopyMarkdown("Lead.", "Lead. And the rest.")).toBe("Lead. And the rest.");
    expect(replyCopyMarkdown("Lead.", "Different body.")).toBe("Lead.\n\nDifferent body.");
    const withSources = replyCopyMarkdown("Answer.\n\n**Sources**\n- Meta Ads pull");
    expect(withSources.startsWith("Answer.")).toBe(true);
  });
});

describe("one Copy per turn", () => {
  it("the last reply to a message copies every reply to it, earlier replies carry no Copy", () => {
    const copy = turnCopyByRow([
      row("u1", "chat_user", "Review the Atlanta ad set"),
      row("a1", "chat_assistant", "Keep it."),
      row("a2", "chat_assistant", RULE),
      row("u2", "chat_user", "thanks"),
      row("a3", "chat_assistant", "Any time."),
    ]);
    expect(copy.get("a1")).toBeNull();
    expect(copy.get("a2")).toBe(`Keep it.\n\n${RULE}`);
    expect(copy.get("a3")).toBe("Any time.");
    expect(copy.has("u1")).toBe(false);
  });

  it("a decision card between replies does not split the turn", () => {
    const copy = turnCopyByRow([
      row("u1", "chat_user", "go"),
      row("a1", "chat_assistant", "First."),
      row("d1", "decision", ""),
      row("a2", "chat_assistant", "Second."),
    ]);
    expect(copy.get("a1")).toBeNull();
    expect(copy.get("a2")).toBe("First.\n\nSecond.");
  });
});
