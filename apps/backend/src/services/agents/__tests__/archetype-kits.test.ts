import { describe, it, expect } from "vitest";
import {
  selectArchetype,
  archetypeHintFor,
  kitBySlug,
  DEFAULT_ARCHETYPE,
  ARCHETYPE_KITS,
} from "@/services/agents/archetype-kits/registry";
import {
  ArchetypeKitSchema,
  ARCHETYPE_SLUGS,
} from "@/services/agents/archetype-kits/types";

describe("archetype kit registry — shape", () => {
  it("every shipped kit validates against the schema", () => {
    for (const kit of ARCHETYPE_KITS) {
      expect(() => ArchetypeKitSchema.parse(kit)).not.toThrow();
    }
  });

  it("ships the five authored kits", () => {
    const slugs = ARCHETYPE_KITS.map((k) => k.slug).sort();
    expect(slugs).toEqual(["blog", "landing", "marketplace", "saas-dashboard", "shop"]);
  });

  it.each([
    ["create a landing page", "landing"],
    ["A launch-ready landing page", "landing"],
    ["Build a modern landing page for FocusFlow", "landing"],
    ["a waitlist page for my new app", "landing"],
    ["an online store selling handmade candles", "shop"],
    ["an ecommerce storefront with a cart and checkout", "shop"],
    ["a blog about climbing", "blog"],
    ["a newsletter and publication about design", "blog"],
    ["A customer portal", "saas-dashboard"],
  ])("classifies %j as %s with real signal", (idea, expected) => {
    const sel = selectArchetype(idea);
    expect(sel.kit.slug).toBe(expected);
    expect(sel.classified).toBe(expected);
    expect(sel.score).toBeGreaterThan(0);
    expect(sel.usedFallback).toBe(false);
  });

  it.each([
    ["A peer-to-peer marketplace where hosts list cars and renters book them", "marketplace"],
    ["An analytics dashboard for B2B ops teams to monitor KPIs and metrics", "saas-dashboard"],
  ])("does not regress %j (still %s)", (idea, expected) => {
    expect(selectArchetype(idea).kit.slug).toBe(expected);
  });

  it("kit slugs are all members of ARCHETYPE_SLUGS", () => {
    for (const kit of ARCHETYPE_KITS) {
      expect(ARCHETYPE_SLUGS).toContain(kit.slug);
    }
  });

  it("kitBySlug returns the authored kit and throws for an unauthored slug", () => {
    expect(kitBySlug("marketplace").slug).toBe("marketplace");
    expect(kitBySlug("saas-dashboard").slug).toBe("saas-dashboard");
    expect(() => kitBySlug("booking")).toThrow();
  });
});

describe("selectArchetype — heuristic selection", () => {
  it("routes a marketplace idea to the marketplace kit", () => {
    const sel = selectArchetype(
      "A peer-to-peer marketplace where hosts list cars and renters book them",
    );
    expect(sel.kit.slug).toBe("marketplace");
    expect(sel.classified).toBe("marketplace");
    expect(sel.score).toBeGreaterThan(0);
    expect(sel.usedFallback).toBe(false);
  });

  it("routes a SaaS-dashboard idea to the saas-dashboard kit", () => {
    const sel = selectArchetype(
      "An analytics dashboard for B2B ops teams to monitor KPIs and metrics",
    );
    expect(sel.kit.slug).toBe("saas-dashboard");
    expect(sel.classified).toBe("saas-dashboard");
    expect(sel.score).toBeGreaterThan(0);
    expect(sel.usedFallback).toBe(false);
  });

  it("falls back to the default kit when the idea gives no archetype signal", () => {
    const sel = selectArchetype("xyzzy plugh quux");
    expect(sel.kit.slug).toBe(DEFAULT_ARCHETYPE);
    expect(sel.score).toBe(0);
    expect(sel.usedFallback).toBe(false);
  });

  it("empty / whitespace idea returns the default kit (never throws)", () => {
    for (const idea of ["", "   ", "\n\t"]) {
      const sel = selectArchetype(idea);
      expect(sel.kit.slug).toBe(DEFAULT_ARCHETYPE);
      expect(sel.score).toBe(0);
    }
  });

  it("classifies a reserved archetype (booking) and routes it to a shipped kit", () => {
    const sel = selectArchetype(
      "Let people book an appointment and pick an availability slot on a calendar",
    );
    expect(sel.classified).toBe("booking");
    expect(sel.kit.slug).toBe("marketplace");
    expect(sel.usedFallback).toBe(true);
  });

  it("classifies a reserved CRM idea and routes it to saas-dashboard", () => {
    const sel = selectArchetype(
      "A CRM to track leads, deals, and contacts through a sales pipeline",
    );
    expect(sel.classified).toBe("crm");
    expect(sel.kit.slug).toBe("saas-dashboard");
    expect(sel.usedFallback).toBe(true);
  });

  it("prefers the more specific multi-word phrase on competing signals", () => {
    const sel = selectArchetype("A place to buy and sell handmade goods, with management tools");
    expect(sel.kit.slug).toBe("marketplace");
  });

  it("is deterministic — same idea always selects the same kit", () => {
    const idea = "A two-sided rental marketplace for tools";
    const a = selectArchetype(idea);
    const b = selectArchetype(idea);
    expect(a).toEqual(b);
  });

  it("is case-insensitive", () => {
    const lower = selectArchetype("a marketplace for listings");
    const upper = selectArchetype("A MARKETPLACE FOR LISTINGS");
    expect(lower.kit.slug).toBe(upper.kit.slug);
    expect(lower.kit.slug).toBe("marketplace");
  });
});

describe("archetypeHintFor — compact forward-fed hint", () => {
  it("derives a small, payload-safe hint from the selection", () => {
    const hint = archetypeHintFor("a marketplace where vendors sell listings");
    expect(hint.slug).toBe("marketplace");
    expect(hint.title).toBe("Two-sided marketplace");
    expect(hint.pages.length).toBeGreaterThan(0);
    expect(hint.components.length).toBeGreaterThan(0);
    expect(hint.tables.length).toBeGreaterThan(0);
    expect(typeof hint.visualMood).toBe("string");
    expect(hint.pages.every((p) => typeof p === "string")).toBe(true);
  });

  it("default-archetype idea still yields a usable hint (no signal)", () => {
    const hint = archetypeHintFor("blorp");
    expect(hint.slug).toBe(DEFAULT_ARCHETYPE);
    expect(hint.score).toBe(0);
    expect(hint.tables).toContain("resources");
  });
});
