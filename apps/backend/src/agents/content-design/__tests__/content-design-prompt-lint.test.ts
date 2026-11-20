
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_MD = readFileSync(join(__dirname, "..", "agent.md"), "utf-8");

describe("content-design prompt — content-design discipline", () => {
  it("frames the role as a content designer", () => {
    expect(AGENT_MD).toMatch(/content designer/i);
  });

  it("starts from a user need", () => {
    expect(AGENT_MD).toMatch(/Start from a user need/i);
  });

  it("says the best format is OFTEN NOT prose", () => {
    expect(AGENT_MD).toMatch(/OFTEN NOT prose/);
  });

  it("treats content as a hypothesis to be tested", () => {
    expect(AGENT_MD).toMatch(/content as a hypothesis to be tested/i);
  });

  it("reduces to minimum-effective copy", () => {
    expect(AGENT_MD).toMatch(/minimum-effective copy/i);
  });

  it("uses success signals (task completion / comprehension / support tickets / activation), not SEO traffic", () => {
    expect(AGENT_MD).toMatch(/success_signal/);
    expect(AGENT_MD).toMatch(/task completion/i);
    expect(AGENT_MD).toMatch(/comprehension/i);
    expect(AGENT_MD).toMatch(/fewer support tickets/i);
    expect(AGENT_MD).toMatch(/activation/i);
  });
});

describe("content-design prompt — safe component_copy contract", () => {
  it("documents the component_copy change type", () => {
    expect(AGENT_MD).toContain("component_copy");
    expect(AGENT_MD).toMatch(/Safe in-product copy contract/i);
  });

  it("requires surgical old_string/new_string edits, never a whole file", () => {
    expect(AGENT_MD).toContain("old_string");
    expect(AGENT_MD).toContain("new_string");
    expect(AGENT_MD).toMatch(/never a whole component file|never assemble or emit the whole file/i);
  });

  it("forbids editing code logic — only human-readable copy / JSX text", () => {
    expect(AGENT_MD).toMatch(/NEVER edit code logic/i);
    expect(AGENT_MD).toMatch(/human-readable copy/i);
  });

  it("states the server applies the edits and opens an approval-gated PR", () => {
    expect(AGENT_MD).toMatch(/server reads the current file/i);
    expect(AGENT_MD).toMatch(/approval-gated PR/i);
  });
});

describe("content-design prompt — SEO framing + TSX ban removed", () => {
  it("does NOT ban proposing TSX/JSX/component edits", () => {
    expect(AGENT_MD).not.toMatch(/Do NOT propose TSX/i);
    expect(AGENT_MD).not.toMatch(/let the engineer agent handle it/i);
  });

  it("drops keyword-research / competitor-rank framing", () => {
    expect(AGENT_MD).not.toMatch(/keyword research/i);
    expect(AGENT_MD).not.toMatch(/competitor.{0,8}rank/i);
    expect(AGENT_MD).not.toMatch(/keyword volume/i);
  });

  it("drops expected SEO/traffic-impact framing", () => {
    expect(AGENT_MD).not.toMatch(/expected SEO/i);
    expect(AGENT_MD).not.toMatch(/SEO\/traffic impact/i);
    expect(AGENT_MD).not.toMatch(/Search Console/i);
  });

  it("contains no em-dashes (plain voice)", () => {
    expect(AGENT_MD).not.toContain("—");
  });
});

describe("content-design prompt — cap-aware graceful finish contract", () => {
  it("mandates finishing WELL UNDER ~1500 words", () => {
    expect(AGENT_MD).toMatch(/WELL UNDER ~?1500 words/);
  });

  it("explains that the pipeline hard-caps payload (motivation)", () => {
    expect(AGENT_MD).toMatch(/hard-caps\s+payload/i);
  });

  it("bans ending mid-sentence", () => {
    expect(AGENT_MD).toMatch(/NEVER end\s+mid-sentence/);
  });

  it("declares a truncated body INVALID", () => {
    expect(AGENT_MD).toMatch(/truncated body is INVALID/i);
  });
});

describe("content-design prompt — no ungrounded specifics contract", () => {
  it("states the No-ungrounded-specifics rule", () => {
    expect(AGENT_MD).toMatch(/No ungrounded specifics in publish copy/i);
  });

  it("requires facts to come from a live tool in THIS run", () => {
    expect(AGENT_MD).toMatch(/live tool.*this run/i);
  });

  it("bans placeholder tokens [PRICE] and [DATE]", () => {
    expect(AGENT_MD).toContain("[PRICE]");
    expect(AGENT_MD).toContain("[DATE]");
    expect(AGENT_MD).toMatch(/NEVER emit placeholder tokens/);
  });

  it("flags memory__search DENIED as a STALE-recall signal", () => {
    expect(AGENT_MD).toContain("memory__search");
    expect(AGENT_MD).toMatch(/DENIED[\s\S]*?STALE/);
  });
});

describe("content-design prompt — no thin deferrals on chat turns", () => {
  it("has the Chat-turns rule heading", () => {
    expect(AGENT_MD).toMatch(/Chat turns/i);
  });

  it("bans a bare deferral response to thin acks", () => {
    expect(AGENT_MD).toMatch(/ping me later/i);
  });

  it("requires either restating the artifact or advancing the work", () => {
    expect(AGENT_MD).toMatch(/restate the concrete artifact/i);
    expect(AGENT_MD).toMatch(/advance the work/i);
  });

  it("declares a zero-substance reply unacceptable", () => {
    expect(AGENT_MD).toMatch(/zero-substance reply is unacceptable/i);
  });
});

describe("content-design prompt — whole-product surface", () => {
  it("does not treat the blog directory as the whole surface", () => {
    expect(AGENT_MD).toMatch(/Do NOT simply regenerate older\s+blog ideas/i);
    expect(AGENT_MD).toMatch(/blog directory as the whole content surface/i);
  });

  it("designs in-product copy (buttons, empty states, errors), not just pages", () => {
    expect(AGENT_MD).toMatch(/In-product copy/i);
    expect(AGENT_MD).toMatch(/empty states/i);
    expect(AGENT_MD).toMatch(/error and validation/i);
  });
});
