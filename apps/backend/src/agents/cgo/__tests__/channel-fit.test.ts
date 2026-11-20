import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHANNELS, RETIRED_CHANNEL_SLUGS } from "@zavi/shared";
import { parseChannelFit, type ChannelBet } from "../strategy";

const bet: ChannelBet = {
  channel_slug: "seo",
  intent: "Publish one comparison page a week",
  rationale: "buyers search for alternatives by name",
  expected_effect: "",
  falsifier: "eight weeks, no page in the top 20",
};

describe("parseChannelFit", () => {
  it("keeps real slugs with a valid value and a real line, once each", () => {
    const out = parseChannelFit(
      [
        { channel_slug: "reddit_organic", value: "Medium", line: "Founders ask for tool picks in r/agency weekly." },
        { channel_slug: "reddit_organic", value: "low", line: "duplicate is dropped, first one wins" },
        { channel_slug: "made_up", value: "high", line: "an invented channel is never rated" },
        { channel_slug: "sms", value: "great", line: "an unknown value is dropped" },
        { channel_slug: "x_organic", value: "low", line: "" },
      ],
      [],
    );
    expect(out).toEqual([
      { channel_slug: "reddit_organic", value: "medium", line: "Founders ask for tool picks in r/agency weekly." },
    ]);
  });

  it("drops a retired channel like an invented one", () => {
    const out = parseChannelFit([{ channel_slug: "blog", value: "high", line: "a retired channel is never rated" }], []);
    expect(out).toEqual([]);
  });

  it("pins every bet to high with the bet's own rationale, overriding the model", () => {
    const out = parseChannelFit([{ channel_slug: "seo", value: "low", line: "the model contradicted its own bet" }], [bet]);
    expect(out).toEqual([{ channel_slug: "seo", value: "high", line: "buyers search for alternatives by name" }]);
  });

  it("clips a long line to one line's worth", () => {
    const out = parseChannelFit([{ channel_slug: "sms", value: "low", line: "x".repeat(400) }], []);
    expect(out[0].line.length).toBeLessThanOrEqual(180);
  });

  it("a missing or malformed field yields bets only, never a throw", () => {
    expect(parseChannelFit(undefined, [bet])).toHaveLength(1);
    expect(parseChannelFit("nope", [])).toEqual([]);
  });
});

describe("the CGO prompt's channel catalog", () => {
  it("names every live registry channel and no retired one", () => {
    const md = readFileSync(join(__dirname, "../agent.md"), "utf8");
    const section = md.slice(md.indexOf("### 6b."), md.indexOf("### 7."));
    for (const c of CHANNELS) {
      const named = section.includes(`\`${c.slug}\``);
      expect(named, `${c.slug} in agent.md 6b`).toBe(!RETIRED_CHANNEL_SLUGS.has(c.slug));
    }
  });
});
