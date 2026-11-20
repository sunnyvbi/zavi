import { describe, expect, it } from "vitest";
import { fieldFromReply, fitToSentences, htmlToText, needsFullerDescription, sentenceCount } from "../description-draft";

describe("sentenceCount", () => {
  it("counts a bare fragment as one sentence", () => {
    expect(sentenceCount("AI")).toBe(1);
    expect(sentenceCount("scheduling software for dental clinics")).toBe(1);
  });

  it("counts terminated sentences, and a trailing fragment as one more", () => {
    expect(sentenceCount("We sell rentals.")).toBe(1);
    expect(sentenceCount("We sell rentals. Hosts list cars.")).toBe(2);
    expect(sentenceCount("We sell rentals. Hosts list cars")).toBe(2);
  });

  it("does not split on a decimal or a domain", () => {
    expect(sentenceCount("Plans from $49.99 on acme.com")).toBe(1);
  });

  it("is zero for an empty description", () => {
    expect(sentenceCount("   ")).toBe(0);
  });
});

describe("needsFullerDescription", () => {
  it("asks for a draft under two sentences only", () => {
    expect(needsFullerDescription("")).toBe(true);
    expect(needsFullerDescription("AI")).toBe(true);
    expect(needsFullerDescription("We sell rentals. Hosts list cars.")).toBe(false);
  });
});

describe("htmlToText", () => {
  it("keeps visible words and drops scripts, styles and tags", () => {
    const html =
      "<html><head><style>.a{}</style><script>track()</script></head><body><h1>Acme</h1><p>Tools&nbsp;for &amp; agencies</p></body></html>";
    expect(htmlToText(html)).toBe("Acme Tools for & agencies");
  });
});

describe("fitToSentences", () => {
  it("keeps text that fits", () => {
    expect(fitToSentences("Short. Sweet.", 50)).toBe("Short. Sweet.");
  });

  it("cuts an over-long answer back to the last whole sentence", () => {
    expect(fitToSentences("One two. Three four. Five six seven.", 25)).toBe("One two. Three four.");
  });

  it("gives up rather than cut mid-sentence", () => {
    expect(fitToSentences("One long sentence with no stop at all", 10)).toBeNull();
  });
});

describe("fieldFromReply", () => {
  it("reads a voice whose quoted words the model did not escape", () => {
    const reply = '{"voice": "Write like a friendly neighbour. Say "you", never "customers"."}';
    expect(fieldFromReply(reply, "voice")).toBe('Write like a friendly neighbour. Say "you", never "customers".');
  });

  it("stops at the first object when the model sends a second one", () => {
    const reply = '{"voice": "Say "you", never "customers"."}\n{"reason": "The homepage reads casually."}';
    expect(fieldFromReply(reply, "voice")).toBe('Say "you", never "customers".');
  });

  it("reads a fenced reply", () => {
    const reply = '```json\n{"voice": "Short sentences, plain words, no hype."}\n```';
    expect(fieldFromReply(reply, "voice")).toBe("Short sentences, plain words, no hype.");
  });

  it("returns null rather than folding a second key into the voice", () => {
    const reply = '{"voice": "Write warmly. Say "you", never "customers".", "reason": "Matches the homepage."}';
    expect(fieldFromReply(reply, "voice")).toBeNull();
  });

  it("undoes the escapes the model did write when it missed others", () => {
    const reply = '{"voice": "Say \\"you\\", never "customers".\\nKeep it short."}';
    expect(fieldFromReply(reply, "voice")).toBe('Say "you", never "customers". Keep it short.');
  });

  it("returns null for a reply with no voice in it", () => {
    expect(fieldFromReply("Sorry, I can't tell from this page.", "voice")).toBeNull();
  });
});
