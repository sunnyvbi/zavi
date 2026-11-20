
import { describe, it, expect } from "vitest";
import {
  STARTER_GROUPS,
  ALL_STARTERS,
  KNOWN_REPORT_TOOLS,
} from "./starters";
import { composerSeedKey } from "./composerSeed";

describe("starter catalog", () => {
  it("cites only tools that actually exist", () => {
    for (const s of ALL_STARTERS) {
      expect(
        KNOWN_REPORT_TOOLS,
        `starter "${s.id}" cites ${s.tool}, which is not a real report tool`,
      ).toContain(s.tool);
    }
  });

  it("uses the report__ double-underscore name the agent actually sees", () => {
    for (const t of KNOWN_REPORT_TOOLS) {
      expect(t).toMatch(/^report__[a-z_]+$/);
    }
  });

  it("gives every entry the three things a buyer needs before committing", () => {
    for (const s of ALL_STARTERS) {
      expect(s.title.length, s.id).toBeGreaterThan(0);
      expect(s.prompt.length, s.id).toBeGreaterThan(20);
      expect(s.produces.length, s.id).toBeGreaterThan(0);
      expect(s.needs.length, s.id).toBeGreaterThan(0);
      expect(s.agent.length, s.id).toBeGreaterThan(0);
      expect(s.agentLabel.length, s.id).toBeGreaterThan(0);
    }
  });

  it("has unique ids and no duplicate prompts", () => {
    const ids = ALL_STARTERS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const prompts = ALL_STARTERS.map((s) => s.prompt);
    expect(new Set(prompts).size).toBe(prompts.length);
  });

  it("groups by outcome, and every group has content", () => {
    expect(STARTER_GROUPS.length).toBeGreaterThan(2);
    for (const g of STARTER_GROUPS) {
      expect(g.starters.length, `group ${g.id} is empty`).toBeGreaterThan(0);
      expect(g.blurb.length, `group ${g.id} has no blurb`).toBeGreaterThan(0);
    }
  });

  it("discloses plainly that the deck link is public and unauthenticated", () => {
    const deckStarters = ALL_STARTERS.filter((s) => s.tool === "report__render_deck");
    expect(deckStarters.length).toBeGreaterThan(0);
    for (const s of deckStarters) {
      const note = (s.note ?? "").toLowerCase();
      expect(note, `${s.id} must say the link is public`).toMatch(/public|anyone/);
      expect(
        note,
        `${s.id} must say no sign-in is required, not just "shareable"`,
      ).toMatch(/without signing in|sign in/);
    }
  });

  it("warns that the wireframe link is public and uses placeholder data", () => {
    const wf = ALL_STARTERS.filter((s) => s.tool === "report__render_wireframe");
    expect(wf.length).toBeGreaterThan(0);
    for (const s of wf) {
      expect((s.note ?? "").toLowerCase()).toMatch(/placeholder|real customer data/);
    }
  });

  it("states the brand-colour requirement on the social entries", () => {
    const social = ALL_STARTERS.filter((s) => s.tool === "report__render_social_image");
    expect(social.length).toBeGreaterThan(0);
    for (const s of social) {
      expect(`${s.needs} ${s.note ?? ""}`.toLowerCase()).toMatch(/brand|hex/);
    }
  });
});

describe("composerSeedKey", () => {
  it("matches the key the Composer drains", () => {
    expect(composerSeedKey("pm")).toBe("praxis:refine-seed:pm");
  });
});
