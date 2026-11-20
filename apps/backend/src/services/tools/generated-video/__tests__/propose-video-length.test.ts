import { describe, it, expect } from "vitest";
import { buildVideoCard, renderIntakeFor, type VideoProposeInput } from "../propose_video";
import { routedVideoPlan } from "@/services/launch-video/video-estimate";
import { SPEAKING_WORDS_PER_SECOND, spokenSeconds } from "@/services/launch-video/generative-video-intake";

const QA_SCRIPT =
  "Setup took me four minutes, and that was the whole job. You connect the calendar, pick the shifts, and the rota fills itself. No spreadsheet, no group chat at midnight. That is the hour a week you get back.";

const input = (script: string): VideoProposeInput => ({
  format: "product_demo",
  hook: "Setup took me four minutes.",
  script,
  scene: "A generic AI presenter at a kitchen table.",
  presenter_gender: "female",
  caption: "Four minutes to set up.",
  objection: "Setup looks slow.",
});

const billedSeconds = (vendorSeconds: number | null, quotedSeconds: number | null): number | null =>
  quotedSeconds != null && vendorSeconds != null ? Math.min(vendorSeconds, quotedSeconds) : (vendorSeconds ?? quotedSeconds);

const wordsIn = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

const scriptOf = (n: number) => Array.from({ length: n }, (_, i) => (i % 7 === 0 ? "rota," : "word")).join(" ");

function cardText(script: string): { body: string; row: string } {
  const card = buildVideoCard(input(script), 120);
  const step = card.body.step as { body: string };
  const rows = (card.body.exact_change as { rows: Array<{ item: string; after: string }> }).rows;
  return { body: step.body, row: rows.find((r) => r.item === "Video")!.after };
}

describe("AI UGC video card: the length it promises is the length of the voiceover", () => {
  it("the QA script that rendered as a 15.6s video is promised as about 15 seconds, never 16 or 20", () => {
    const { body, row } = cardText(QA_SCRIPT);
    expect(wordsIn(QA_SCRIPT)).toBe(39);
    expect(body).toContain("about 15 seconds");
    expect(row).toBe("Product demo, about 15 seconds, 9:16");
    expect(`${body} ${row}`).not.toMatch(/\b20(-second|s\b| seconds)/);
  });

  it("follows the script's word count at the quoting pace across the whole allowed range", () => {
    const seen = new Set<string>();
    for (let n = 20; n <= 70; n++) {
      const { body, row } = cardText(scriptOf(n));
      const expected = Math.max(1, Math.floor(n / SPEAKING_WORDS_PER_SECOND));
      expect(body, `${n} words`).toContain(`about ${expected} seconds`);
      expect(row, `${n} words`).toContain(`about ${expected} seconds`);
      seen.add(row);
    }
    expect(seen.size).toBeGreaterThan(15);
  });

  it("uses the same pace the quote uses: the card is the quoted speech minus its one-second tail, give or take rounding", () => {
    for (let n = 20; n <= 70; n++) {
      const script = scriptOf(n);
      const card = Number(/about (\d+) seconds/.exec(cardText(script).body)![1]);
      expect(Math.abs(card - (spokenSeconds(script) - 1)), `${n} words`).toBeLessThanOrEqual(1);
    }
  });

  it("never promises a longer video than the seconds the founder is charged for", () => {
    for (let n = 20; n <= 70; n++) {
      const script = scriptOf(n);
      const card = Number(/about (\d+) seconds/.exec(cardText(script).body)![1]);
      const plan = routedVideoPlan(renderIntakeFor(input(script)));
      expect(plan.task).toBe("video.talking_head");
      expect(card, `${n} words`).toBeLessThanOrEqual(plan.clipSeconds);
    }
  });

  it("the QA case: a 15.6s render billed at min(vendor, quote) is never less than the seconds the card promised", () => {
    const card = Number(/about (\d+) seconds/.exec(cardText(QA_SCRIPT).body)![1]);
    const plan = routedVideoPlan(renderIntakeFor(input(QA_SCRIPT)));
    const billed = billedSeconds(15.6, plan.clipSeconds)!;
    expect(billed).toBe(15.6);
    expect(card).toBeLessThanOrEqual(billed);
  });

  it("across 20-70 words, a video exactly as long as its voiceover is billed at least the seconds the card promised", () => {
    for (let n = 20; n <= 70; n++) {
      const script = scriptOf(n);
      const card = Number(/about (\d+) seconds/.exec(cardText(script).body)![1]);
      const plan = routedVideoPlan(renderIntakeFor(input(script)));
      const vendorSeconds = n / SPEAKING_WORDS_PER_SECOND;
      const billed = billedSeconds(vendorSeconds, plan.clipSeconds)!;
      expect(billed, `${n} words`).toBe(vendorSeconds);
      expect(card, `${n} words: card ${card}s vs billed ${billed}s`).toBeLessThanOrEqual(billed);
    }
  });

  it("counts words the way speech runs, not characters or line breaks", () => {
    const spaced = cardText(`  ${scriptOf(40).split(" ").join("\n\n  ")}  `);
    expect(spaced.body).toContain("about 16 seconds");
  });
});
