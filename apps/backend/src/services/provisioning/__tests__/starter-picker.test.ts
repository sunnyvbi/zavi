import { describe, it, expect } from "vitest";
import { classifyPrompt, STARTER_CATEGORIES } from "@/services/provisioning/starter-picker";

describe("classifyPrompt", () => {
  it("returns 'generic' on empty/whitespace/non-string", () => {
    expect(classifyPrompt("")).toBe("generic");
    expect(classifyPrompt("   ")).toBe("generic");
    expect(classifyPrompt(undefined)).toBe("generic");
    expect(classifyPrompt(null)).toBe("generic");
    expect(classifyPrompt(123 as unknown as string)).toBe("generic");
  });

  it("returns 'generic' for prompts with no category keywords", () => {
    expect(classifyPrompt("weather widget that polls every minute")).toBe("generic");
    expect(classifyPrompt("a Sudoku solver")).toBe("generic");
  });

  it("classifies todo prompts", () => {
    expect(classifyPrompt("a simple to-do list")).toBe("todo");
    expect(classifyPrompt("todo app for my team")).toBe("todo");
    expect(classifyPrompt("a task tracker")).toBe("todo");
    expect(classifyPrompt("Build a task manager with priorities")).toBe("todo");
    expect(classifyPrompt("checklist app for housekeepers")).toBe("todo");
  });

  it("classifies blog prompts", () => {
    expect(classifyPrompt("blog with posts")).toBe("blog");
    expect(classifyPrompt("a blogging platform")).toBe("blog");
    expect(classifyPrompt("simple cms for articles")).toBe("blog");
    expect(classifyPrompt("publishing posts for writers")).toBe("blog");
  });

  it("classifies dashboard prompts", () => {
    expect(classifyPrompt("admin dashboard with KPIs")).toBe("dashboard");
    expect(classifyPrompt("internal tool for analytics")).toBe("dashboard");
    expect(classifyPrompt("metrics monitor for our team")).toBe("dashboard");
    expect(classifyPrompt("admin panel for support")).toBe("dashboard");
  });

  it("classifies auth prompts", () => {
    expect(classifyPrompt("auth app for my team")).toBe("auth");
    expect(classifyPrompt("login + signup for my app")).toBe("auth");
    expect(classifyPrompt("user account system")).toBe("auth");
    expect(classifyPrompt("registration flow")).toBe("auth");
  });

  it("classifies shop prompts", () => {
    expect(classifyPrompt("shop selling handmade soap")).toBe("shop");
    expect(classifyPrompt("storefront for my t-shirts")).toBe("shop");
    expect(classifyPrompt("ecommerce site with checkout")).toBe("shop");
    expect(classifyPrompt("e-commerce store")).toBe("shop");
    expect(classifyPrompt("product catalog with a cart")).toBe("shop");
  });

  it("classifies landing prompts", () => {
    expect(classifyPrompt("marketing landing page")).toBe("landing");
    expect(classifyPrompt("simple landing page for my SaaS")).toBe("landing");
    expect(classifyPrompt("coming soon page with waitlist")).toBe("landing");
    expect(classifyPrompt("one-pager for my product")).toBe("landing");
  });

  it("is case-insensitive", () => {
    expect(classifyPrompt("BLOG with POSTS")).toBe("blog");
    expect(classifyPrompt("Admin Dashboard")).toBe("dashboard");
    expect(classifyPrompt("LANDING PAGE")).toBe("landing");
  });

  it("returns only known categories (no typos / surprises)", () => {
    const seen = new Set<string>();
    for (const idea of [
      "to-do",
      "blog with posts",
      "admin dashboard",
      "auth app",
      "shop",
      "landing page",
      "weather widget",
      "",
    ]) {
      seen.add(classifyPrompt(idea));
    }
    for (const c of seen) {
      expect(STARTER_CATEGORIES).toContain(c);
    }
  });

  it("ordering rule — when two categories could match, the more-specific one wins (shop > dashboard for 'shop dashboard')", () => {
    expect(classifyPrompt("shop dashboard for my store owners")).toBe("shop");
  });
});
