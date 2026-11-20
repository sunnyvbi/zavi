import { describe, it, expect, vi, beforeEach } from "vitest";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const settingsMock = vi.hoisted(() => ({ getBoolSetting: vi.fn() }));
vi.mock("@/services/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/settings")>()),
  getBoolSetting: settingsMock.getBoolSetting,
}));

import { seedProvisionedRepo } from "@/services/provisioning/seed-provisioned-repo";
import { buildStarterFiles } from "@/services/provisioning/templates/starters";
import { TEMPLATE_FILES } from "@/services/provisioning/templates/nextjs-supabase-tailwind/template-files.generated";
import { looksLikeSeedPlaceholder } from "@/services/provisioning/seed-markers";
import { APP_SETTINGS } from "@/services/settings/registry";
import { buildRemediationMessage } from "@/services/agents/postdeploy-remediate";
import type { SeedTemplateDeps } from "@/services/provisioning/seed-template";

const YOGA_IDEA = "A website for my yoga studio where students can see the schedule and book a class";

function renderPage(source: string): string {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod: { exports: { default?: () => React.ReactElement } } = { exports: {} };
  const requireStub = (name: string) => {
    if (name === "@/lib/supabase") return { hasSupabaseConfig: () => false };
    if (name === "react") return React;
    if (name === "@/app/components/TodoApp") return { default: () => React.createElement("ul", null, "No tasks yet.") };
    if (name === "next/link")
      return { default: (p: { href: string; children: React.ReactNode }) => React.createElement("a", { href: p.href }, p.children) };
    if (name === "@/app/components/KpiCard")
      return { default: (p: { label: string; value: string }) => React.createElement("div", null, `${p.label} ${p.value}`) };
    if (name === "@/lib/data/mocks") return { kpis: () => [{ label: "Revenue", value: "$12,438" }] };
    throw new Error(`unexpected import ${name}`);
  };
  new Function("module", "exports", "require", "React", js)(mod, mod.exports, requireStub, React);
  const Page = mod.exports.default!;
  return renderToStaticMarkup(React.createElement(Page));
}

function renderFromRepo(files: Record<string, string>): string {
  const cache = new Map<string, unknown>();
  const load = (path: string): unknown => {
    if (cache.has(path)) return cache.get(path);
    const js = ts.transpileModule(files[path], {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const mod: { exports: Record<string, unknown> } = { exports: {} };
    cache.set(path, mod.exports);
    const req = (name: string): unknown => {
      if (name === "react") return React;
      if (name === "@/lib/supabase") return { hasSupabaseConfig: () => false };
      if (name === "next/link")
        return { default: (p: { href: string; children: React.ReactNode }) => React.createElement("a", { href: p.href }, p.children) };
      if (name.startsWith("@/")) {
        const base = name.slice(2);
        const hit = [`${base}.tsx`, `${base}.ts`].find((c) => files[c] !== undefined);
        if (!hit) throw new Error(`unresolved import ${name}`);
        return load(hit);
      }
      throw new Error(`unexpected import ${name}`);
    };
    new Function("module", "exports", "require", "React", js)(mod, mod.exports, req, React);
    cache.set(path, mod.exports);
    return mod.exports;
  };
  const Page = (load("app/page.tsx") as { default: () => React.ReactElement }).default;
  return renderToStaticMarkup(React.createElement(Page));
}

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function seedWithCapture(extra: Record<string, unknown> = {}) {
  let pushed: Record<string, string> | undefined;
  const seed = vi.fn(async (_t: string, _r: string, d: SeedTemplateDeps) => {
    pushed = d.files as Record<string, string>;
    return { seeded: true as const, commit_sha: "abc", branch: "main", file_count: Object.keys(pushed).length };
  });
  const r = await seedProvisionedRepo("tenant-yoga", "Praxis-build/apna-tutor-693dfbdb", {
    enabled: () => true,
    seed,
    idea: YOGA_IDEA,
    ...extra,
  });
  return { r, page: pushed?.["app/page.tsx"] ?? "", files: pushed ?? {} };
}

describe("DEL-1323 B7: the public URL never shows the developer starter page", () => {
  beforeEach(() => {
    settingsMock.getBoolSetting.mockReset();
  });

  it("registers build_visitor_safe_seed as a per-tenant key, default ON", () => {
    const def = APP_SETTINGS.build_visitor_safe_seed;
    expect(def.type).toBe("boolean");
    expect(def.scope).toBe("per-tenant");
    expect(def.defaultValue).toBe(true);
  });

  it("with the key on, what a visitor reads on a fresh build's address has no developer text or database pill", async () => {
    settingsMock.getBoolSetting.mockResolvedValue(true);
    const { r, page } = await seedWithCapture();
    expect(r.seeded).toBe(true);
    expect(settingsMock.getBoolSetting).toHaveBeenCalledWith("build_visitor_safe_seed", "tenant-yoga");

    const html = renderPage(page);
    const text = visibleText(html);
    expect(text).toBe("Coming soon This site is being built. Check back shortly.");
    for (const leak of ["app/page.tsx", "Edit", "Next.js", "starter", "Database", "deploy", "Your company app is live"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("the deploy check still recognises the rendered visitor-safe page as the placeholder, even after the title is changed", async () => {
    settingsMock.getBoolSetting.mockResolvedValue(true);
    const { page } = await seedWithCapture();
    const served = `<html><head><title>Still Water Yoga</title></head><body>${renderPage(page)}</body></html>`;
    expect(looksLikeSeedPlaceholder(served)).toBe(true);
  });

  it("with the key off, the old starter page is pushed byte for byte", async () => {
    settingsMock.getBoolSetting.mockResolvedValue(false);
    const { page } = await seedWithCapture();
    expect(page).toBe(TEMPLATE_FILES["app/page.tsx"]);
    expect(visibleText(renderPage(page))).toContain("Database not configured yet");
  });

  it("a failed settings read keeps the old starter page", async () => {
    settingsMock.getBoolSetting.mockRejectedValue(new Error("settings down"));
    const { r, page } = await seedWithCapture();
    expect(r.seeded).toBe(true);
    expect(page).toBe(TEMPLATE_FILES["app/page.tsx"]);
  });

  const ALL_CATEGORIES = ["todo", "blog", "dashboard", "auth", "shop", "landing", "generic"] as const;
  const PLACEHOLDER_TEXT = "Coming soon This site is being built. Check back shortly.";

  it("every category gets the placeholder page and keeps all its other files for the engineer", () => {
    for (const cat of ALL_CATEGORIES) {
      const plain = buildStarterFiles(cat);
      const safe = buildStarterFiles(cat, { visitorSafe: true });
      expect(safe["app/page.tsx"], cat).toContain('data-zavi-seed="placeholder"');
      expect(safe["app/page.tsx"], cat).not.toContain("Sample tee");
      expect(Object.keys(safe).sort(), cat).toEqual(Object.keys(plain).sort());
      for (const path of Object.keys(plain)) {
        if (path !== "app/page.tsx") expect(safe[path], `${cat} ${path}`).toBe(plain[path]);
      }
    }
    expect(buildStarterFiles("shop", { visitorSafe: true })["app/components/ProductGrid.tsx"]).toContain("Sample tee");
    expect(buildStarterFiles("landing", { visitorSafe: true })["app/components/Hero.tsx"]).toBeDefined();
  });

  it("with the key off, the shop starter really renders its storefront through the repo renderer", async () => {
    settingsMock.getBoolSetting.mockResolvedValue(false);
    const { files } = await seedWithCapture({ category: "shop" });
    const text = visibleText(renderFromRepo(files));
    expect(text).toContain("Sample tee");
    expect(text).toContain("$24");
  });

  it.each(ALL_CATEGORIES)("with the key on, the %s starter's public address renders only Coming soon", async (category) => {
    settingsMock.getBoolSetting.mockResolvedValue(true);
    const { r, files } = await seedWithCapture({ category });
    expect(r.seeded).toBe(true);
    const html = renderFromRepo(files);
    const text = visibleText(html);
    expect(text).toBe(PLACEHOLDER_TEXT);
    for (const leak of ["Sample tee", "Sample mug", "Sample tote", "$24", "Shop", "Cart", "Pricing", "Starter", "starter", "Revenue", "Database"]) {
      expect(text).not.toContain(leak);
    }
    expect(looksLikeSeedPlaceholder(`<html><head><title>Still Water Yoga</title></head><body>${html}</body></html>`)).toBe(true);
  });

  it.each(ALL_CATEGORIES)("with the key on, a customised %s page that kept the <main> wrapper is not flagged as the placeholder", async (category) => {
    settingsMock.getBoolSetting.mockResolvedValue(true);
    const { files } = await seedWithCapture({ category });
    const page = files["app/page.tsx"];
    const customised = page
      .split("Coming soon").join("Still Water Yoga")
      .split("This site is being built. Check back shortly.").join("Book your next class.");
    expect(customised).not.toBe(page);
    expect(customised).toContain("<main");
    const served = `<html><head><title>Still Water Yoga</title></head><body>${renderFromRepo({ ...files, "app/page.tsx": customised })}</body></html>`;
    expect(looksLikeSeedPlaceholder(served)).toBe(false);
  });

  const CATEGORY_DEV_TEXT = {
    todo: "A starter to-do app. Extend it.",
    blog: "Starter blog. Add posts.",
    dashboard: "Starter view. Replace mocks with real data.",
  } as const;
  const CATEGORIES = Object.keys(CATEGORY_DEV_TEXT) as Array<keyof typeof CATEGORY_DEV_TEXT>;

  it.each(CATEGORIES)("with the key off, the %s starter is pushed byte for byte and its developer text now fails the real-app check", async (category) => {
    settingsMock.getBoolSetting.mockResolvedValue(false);
    const { page } = await seedWithCapture({ category });
    expect(page).toBe(buildStarterFiles(category)["app/page.tsx"]);
    expect(page).not.toContain("data-zavi-seed");
    const html = renderPage(page);
    expect(visibleText(html)).toContain(CATEGORY_DEV_TEXT[category]);
    expect(looksLikeSeedPlaceholder(`<html><head><title>Still Water Yoga</title></head><body>${html}</body></html>`)).toBe(true);
  });

  it("the generic placeholder copy alone is caught even if the marker attribute is stripped", async () => {
    settingsMock.getBoolSetting.mockResolvedValue(true);
    const { page } = await seedWithCapture();
    const html = renderPage(page).replace(/ data-zavi-seed="placeholder"/g, "");
    expect(looksLikeSeedPlaceholder(`<title>Still Water Yoga</title>${html}`)).toBe(true);
  });

  it("the engineer's fix message for a seed still live names every seed marker, not only the old headline", () => {
    const m = buildRemediationMessage({
      verdict: "postdeploy_seed_no_codegen",
      status_code: 200,
      snippet: "",
      attempt: 1,
    });
    for (const marker of [
      'data-zavi-seed="placeholder"',
      "Coming soon. This site is being built.",
      "Your company app is live.",
      ...Object.values(CATEGORY_DEV_TEXT),
    ]) {
      expect(m).toContain(marker);
    }
  });

  it("files passed by the caller win and skip the settings read", async () => {
    const files = { "app/page.tsx": "custom" };
    const { page } = await seedWithCapture({ files });
    expect(page).toBe("custom");
    expect(settingsMock.getBoolSetting).not.toHaveBeenCalled();
  });
});
