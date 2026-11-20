import { expect, it } from "vitest";
import { geoHeadline, geoVisibilityModel, sharePercent } from "./visibilityModel";

const cell = (collected: number, mentioned = 0, cited = 0) => ({ collected, mentioned, cited });
const row = (id: string, text: string, chatgpt: ReturnType<typeof cell>, perplexity: ReturnType<typeof cell>, gemini: ReturnType<typeof cell>) => ({
  prompt_id: id, prompt_text: text, engines: { chatgpt, perplexity, gemini, claude: cell(0) },
  all: cell(chatgpt.collected + perplexity.collected + gemini.collected, chatgpt.mentioned + perplexity.mentioned + gemini.mentioned, chatgpt.cited + perplexity.cited + gemini.cited),
});
const rows = [
  row("a", "best way to rent a car for uber", cell(1), cell(1, 1), cell(1)),
  row("b", "cheapest car rental for doordash", cell(1, 1), cell(1, 1, 1), cell(1)),
  row("c", "can i use a rental car for lyft", cell(1), cell(1), cell(1)),
  row("d", "alternatives to hyrecar", cell(1, 1), cell(1, 1, 1), cell(1, 1)),
];
const payload = (over: Record<string, unknown> = {}) => ({
  visibility: {
    state: "ok", country: "US", window_days: 30, running: null, history: [],
    deltas: { mention_rate: { delta_pp: 2, significant: true }, citation_rate: { delta_pp: -1.5, significant: true }, share_of_voice: { delta_pp: 4, significant: false } },
    config: { enabled: true, configured: true, brand: "Upcar", prompts_active: 40, suggestions_pending: 0, engines: [{ id: "chatgpt", label: "ChatGPT" }, { id: "claude", label: "Claude" }, { id: "perplexity", label: "Perplexity" }, { id: "gemini", label: "Gemini" }], countries: [] },
    metrics: {
      mention_rate: { numerator: 6, denominator: 12, rate: 0.5, by_engine: [] },
      citation_rate: { numerator: 2, denominator: 12, rate: 0.17, by_engine: [] },
      share_of_voice: { state: "ok", share: 0.07, brand_mentions: 7, rival_mentions: 93, rivals: [{ name: "HyreCar", mentions: 31, share: 0.31 }, { name: "Turo", mentions: 38, share: 0.38 }, { name: "Getaround", mentions: 24, share: 0.24 }] },
      prompt_grid: { rows, totals: { engines: { chatgpt: cell(4, 2), perplexity: cell(4, 3, 2), gemini: cell(4, 1), claude: cell(0) }, all: cell(12, 6, 2) } },
      ...over,
    },
  },
});

it("maps the sampled answers onto the tiles, the prompt grid and share of voice", () => {
  const model = geoVisibilityModel(payload())!;
  const m = model.measured!;
  expect([m.promptsMentioned, m.promptsAsked, m.citations, m.share, model.promptsTracked]).toEqual([3, 4, 2, 0.07, 40]);
  expect(m.engines.map((e) => e.label)).toEqual(["ChatGPT", "Perplexity", "Gemini"]);
  expect(m.prompts.map((p) => p.cells)).toEqual([
    ["absent", "mentioned", "absent"],
    ["mentioned", "cited", "absent"],
    ["absent", "absent", "absent"],
    ["mentioned", "cited", "mentioned"],
  ]);
  expect(m.voices.map((v) => [v.name, v.share, v.own])).toEqual([["Turo", 0.38, false], ["HyreCar", 0.31, false], ["Getaround", 0.24, false], ["Upcar", 0.07, true]]);
  expect(m.deltas).toEqual({
    mentions: { delta: { pct: 2, up: true }, since: "vs the period before", note: null },
    citations: { delta: { pct: 1.5, up: false }, since: "vs the period before", note: null },
    share: { delta: null, since: "vs the period before", note: "No real change vs the period before" },
  });
  expect(geoHeadline(model)).toBe("AI tools mention Upcar in 3 of your 4 tracked prompts, so most people asking hear about you.");
});

it("never invents numbers: no sample means no tiles' values, and an unanswered engine reads as a dash", () => {
  const empty = geoVisibilityModel({ visibility: { ...payload().visibility, metrics: null } })!;
  expect(empty.measured).toBeNull();
  expect(empty.promptsTracked).toBe(40);
  expect(geoHeadline(empty)).toBeNull();
  expect(geoVisibilityModel({ visibility: { error: true } })).toBeNull();
  const noRivals = geoVisibilityModel(payload({ share_of_voice: { state: "no_rivals", share: null, brand_mentions: 7, rival_mentions: 0, rivals: [] } }))!.measured!;
  expect(noRivals.share).toBeNull();
  expect(noRivals.voices).toEqual([]);
  expect(noRivals.voiceNote).toContain("No rivals are listed yet");
});

it("does not round a small or near-total share to 0% or 100%", () => {
  expect([0.0046, 0.9954, 0.07, 0, 1].map(sharePercent)).toEqual(["0.5%", "99.5%", "7%", "0%", "100%"]);
});

it("with no earlier window, compares the latest check with the one before it", () => {
  const check = (mention_rate: number | null, over: Record<string, unknown> = {}) => ({ sweep_id: String(mention_rate), finished_at: null, mention_rate, citation_rate: 0, share_of_voice: mention_rate, rival_set_changed: false, prompt_set_changed: false, ...over });
  const none = { unavailable: "no_previous_window" };
  const withHistory = (history: unknown[]) => {
    const p = payload();
    return geoVisibilityModel({ visibility: { ...p.visibility, deltas: { mention_rate: none, citation_rate: none, share_of_voice: none }, history } })!.measured!.deltas;
  };
  const fell = withHistory([check(0), check(0.0167), check(0)]);
  expect(fell.mentions).toEqual({ delta: { pct: 1.7, up: false }, since: "vs the check before", note: null });
  expect(fell.citations).toEqual({ delta: null, since: "vs the check before", note: "Citation rate: No change vs the check before" });
  expect(withHistory([check(0.1)]).mentions.note).toBe("Mention rate: Nothing to compare with yet");
  expect(withHistory([check(0), check(0.2, { prompt_set_changed: true })]).mentions.note).toBe("Mention rate: Nothing to compare with yet");
  const rivalsMoved = withHistory([check(0), check(0.2, { rival_set_changed: true })]);
  expect(rivalsMoved.mentions.delta).toEqual({ pct: 20, up: true });
  expect(rivalsMoved.share.note).toBe("Nothing to compare with yet");
});

it("leaves a prompt whose every answer failed out of the counts, and keeps its row as dashes", () => {
  const failed = row("e", "is upcar insured", cell(0), cell(0), cell(0));
  const unmentioned = rows[2];
  const p = payload({ prompt_grid: { rows: [unmentioned, failed], totals: { engines: { chatgpt: cell(1), perplexity: cell(1), gemini: cell(1), claude: cell(0) }, all: cell(3) } } });
  const model = geoVisibilityModel(p)!;
  expect([model.measured!.promptsMentioned, model.measured!.promptsAsked]).toEqual([0, 1]);
  expect(geoHeadline(model)).toBe("AI tools do not mention Upcar in any of your 1 tracked prompts yet.");
  expect(model.measured!.prompts.map((r) => r.cells)).toEqual([["absent", "absent", "absent"], ["none", "none", "none"]]);
});

it("keeps an assistant whose planned calls all failed as a column of dashes, and leaves out one that was never scheduled", () => {
  const coverage = [{ engine: "chatgpt", planned: 4 }, { engine: "perplexity", planned: 4 }, { engine: "gemini", planned: 4 }, { engine: "claude", planned: 0 }];
  const totals = { engines: { chatgpt: cell(4, 2), perplexity: cell(0), gemini: cell(4, 1), claude: cell(0) }, all: cell(8, 3) };
  const grid = rows.map((r) => ({ ...r, engines: { ...r.engines, perplexity: cell(0) } }));
  const m = geoVisibilityModel(payload({ prompt_coverage: coverage, prompt_grid: { rows: grid, totals } }))!.measured!;
  expect(m.engines.map((e) => e.label)).toEqual(["ChatGPT", "Perplexity", "Gemini"]);
  expect(m.prompts.map((p) => p.cells[1])).toEqual(["none", "none", "none", "none"]);
});
