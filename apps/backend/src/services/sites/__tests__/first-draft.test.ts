
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SITE_REPO_DIR } from "../contract";
import type { DesignBrief } from "../design-brief";
import {
  CLEAR_FIRST_DRAFT_CMD,
  DRAFT_HOME_PATH,
  FIRST_DRAFT_DIR,
  FIRST_DRAFT_HOME_ABS,
  FIRST_DRAFT_MESSAGE,
  FIRST_DRAFT_PATH,
  buildFirstDraft,
  clearFirstDraftForSite,
  draftStepOf,
  firstDraftFile,
  firstDraftForRun,
  ideaLine,
  isFirstSiteBuildPayload,
  placeholderHomeSha1s,
  sha1Hex,
  writeFirstDraftCmd,
  type FirstDraftFile,
} from "../first-draft";
import { SITE_PREVIEW_CONFIG_PATH, sitePreviewConfigSource, writeSitePreviewConfigCmd } from "../preview-picker";
import { zaviStarterProvider } from "@/services/provisioning/templates/vite-react-zavi";
import { viteStarterProvider } from "@/services/provisioning/templates/vite-react-supabase";

const COLORS: DesignBrief["colors"] = {
  background: "#ffffff",
  foreground: "#111111",
  muted: "#f4f4f4",
  "muted-foreground": "#555555",
  primary: "#1d4ed8",
  "primary-foreground": "#ffffff",
  border: "#e5e5e5",
};

function brief(sections: Array<[string, string]>, action: [string, string]): DesignBrief {
  return {
    industry: "x",
    mood: "warm",
    mode: "light",
    colors: COLORS,
    fonts: { heading: "Fraunces", body: "Inter" },
    plan: {
      tone: "friendly",
      primary_action: { label: action[0], steps: action[1] },
      pages: [{ path: "/", title: "Home", sections: sections.map(([name, headline]) => ({ name, headline })) }],
    },
  };
}

const firstBuild = (extra: Record<string, unknown> = {}) => ({
  stage: "build",
  fast_single_pass: true,
  site_id: "site-1",
  target: { github_full_name: "praxis-built/s" },
  idea: "Build me a website for my bakery where people order custom cakes for pickup",
  ...extra,
});

describe("buildFirstDraft", () => {
  it("renders the brief's home plan: hero headline, cards, and the main action (bakery, dentist, photographer)", () => {
    const bakery = buildFirstDraft({
      name: "Crumb & Co",
      idea: "a bakery that takes custom cake orders",
      brief: brief(
        [
          ["Hero", "Custom cakes, baked the morning you pick them up"],
          ["Menu", "Sponges, tarts and seasonal bakes"],
          ["How ordering works", "Pick a size, a flavour and a day"],
        ],
        ["Order a cake", "Choose your cake, pick a pickup day, pay on collection."],
      ),
    });
    expect(bakery).toEqual({
      name: "Crumb & Co",
      headline: "Custom cakes, baked the morning you pick them up",
      subhead: "A bakery that takes custom cake orders",
      action: { label: "Order a cake", steps: "Choose your cake, pick a pickup day, pay on collection." },
      sections: [
        { name: "Menu", text: "Sponges, tarts and seasonal bakes" },
        { name: "How ordering works", text: "Pick a size, a flavour and a day" },
      ],
    });

    const dentist = buildFirstDraft({
      name: "Bright Smile Dental",
      idea: "dentist office with online booking",
      brief: brief([["Hero", "Gentle dental care, booked in a minute"], ["Services", "Checkups, cleanings and whitening"]], ["Book a visit", "Pick a time that suits you."]),
    });
    expect(dentist?.headline).toBe("Gentle dental care, booked in a minute");
    expect(dentist?.action?.label).toBe("Book a visit");
    expect(dentist?.sections).toEqual([{ name: "Services", text: "Checkups, cleanings and whitening" }]);

    const photographer = buildFirstDraft({
      name: "Lena Park Photography",
      idea: "portfolio for a wedding photographer",
      brief: brief([["Hero", "Wedding stories told in natural light"], ["Portfolio", "Recent weddings"], ["About", "Ten years behind the lens"]], ["Check a date", "Send your date and venue."]),
    });
    expect(photographer?.sections.map((s) => s.name)).toEqual(["Portfolio", "About"]);
  });

  it("without a brief plan it shows the site's name over the founder's own words, and invents nothing", () => {
    expect(buildFirstDraft({ name: "Crumb & Co", idea: "Build me a website for my bakery where people order custom cakes. Also a blog." })).toEqual({
      name: "Crumb & Co",
      headline: "Crumb & Co",
      subhead: "My bakery where people order custom cakes",
      action: null,
      sections: [],
    });
    expect(buildFirstDraft({ name: "", idea: "a booking page for my dental office" })?.headline).toBe("A booking page for my dental office");
    expect(buildFirstDraft({ name: "  ", idea: "" })).toBeNull();
    expect(buildFirstDraft({ name: "Lena Park", idea: "wedding photography", brief: { mood: "x" } })?.sections).toEqual([]);
  });

  it("caps and cleans every string (control and bidi characters never reach the page)", () => {
    const d = buildFirstDraft({ name: `A‮B${"x".repeat(200)}`, idea: "y" });
    expect(d!.name.length).toBeLessThanOrEqual(60);
    expect(d!.name).not.toMatch(/‮/);
    expect(ideaLine("please build a site for: tea shop")).toBe("Please build a site for: tea shop");
    expect(ideaLine("Create an app that tracks dog walks!")).toBe("Tracks dog walks");
  });
});

describe("which runs get a draft", () => {
  it("only a site's first build (its first pass or a repair of it); never a refine or an old-flow scaffold", () => {
    expect(isFirstSiteBuildPayload(firstBuild())).toBe(true);
    expect(isFirstSiteBuildPayload(firstBuild({ repair_mode: true }))).toBe(true);
    expect(isFirstSiteBuildPayload(firstBuild({ refine_mode: true }))).toBe(false);
    expect(isFirstSiteBuildPayload(firstBuild({ refine_mode: true, repair_mode: true }))).toBe(false);
    expect(isFirstSiteBuildPayload(firstBuild({ stage: "scaffold" }))).toBe(false);
    expect(isFirstSiteBuildPayload(firstBuild({ fast_single_pass: false }))).toBe(false);
    expect(isFirstSiteBuildPayload(null)).toBe(false);
    expect(firstDraftForRun(firstBuild({ refine_mode: true }), "Crumb")).toBeNull();
    const f = firstDraftForRun(firstBuild(), "Crumb & Co");
    expect(f?.draft.name).toBe("Crumb & Co");
    expect(f?.placeholder_sha1s).toEqual(placeholderHomeSha1s());
  });

  it("stands in only for the placeholder of a starter that ships the section library the draft is built from", () => {
    const pooled = zaviStarterProvider.starterFiles().files;
    const dedicated = viteStarterProvider.starterFiles().files;
    expect(typeof pooled[DRAFT_HOME_PATH]).toBe("string");
    expect(typeof pooled["src/components/sections/index.ts"]).toBe("string");
    expect(placeholderHomeSha1s()).toContain(sha1Hex(pooled[DRAFT_HOME_PATH]!));
    expect(placeholderHomeSha1s([dedicated])).toEqual(typeof dedicated["src/components/sections/index.ts"] === "string" ? [sha1Hex(dedicated[DRAFT_HOME_PATH]!)] : []);
    expect(placeholderHomeSha1s([{ [DRAFT_HOME_PATH]: "x" }])).toEqual([]);
    expect(placeholderHomeSha1s([{}])).toEqual([]);
    expect(firstDraftFile({ name: "a", headline: "a", subhead: "", action: null, sections: [] }, [])).toBeNull();
  });
});

describe("the draft file command", () => {
  let dir = "";
  let home = "";
  const HOME = "export default function Home() { return 'placeholder'; }\n";
  const at = (cmd: string, draftDir = dir) => cmd.split(FIRST_DRAFT_DIR).join(draftDir).split(FIRST_DRAFT_HOME_ABS).join(home);
  const sh = (cmd: string) => execFileSync("bash", ["-c", cmd]).toString();
  const minimal = { name: "a", headline: "a", subhead: "", action: null, sections: [] };
  beforeAll(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zdraft-")));
    dir = join(root, "draft");
    home = join(root, "Home.tsx");
  });
  afterAll(() => rmSync(dirname(dir), { recursive: true, force: true }));

  it("writes the exact JSON (founder text is never shell-interpolated) and clears it", () => {
    writeFileSync(home, HOME);
    const file: FirstDraftFile = {
      v: 1,
      placeholder_sha1s: [sha1Hex(HOME)],
      draft: { name: `It's $(touch /tmp/zavi-pwned) \`id\``, headline: "'; rm -rf / #", subhead: "\"q\"", action: null, sections: [] },
    };
    expect(draftStepOf(sh(at(writeFirstDraftCmd(file))))).toBe("written");
    expect(JSON.parse(readFileSync(join(dir, "first-draft.json"), "utf8"))).toEqual(file);
    expect(draftStepOf(sh(at(CLEAR_FIRST_DRAFT_CMD)))).toBe("cleared");
    expect(() => readFileSync(join(dir, "first-draft.json"))).toThrow();
    expect(draftStepOf(sh(at(CLEAR_FIRST_DRAFT_CMD)))).toBe("cleared");
  });

  it("writes nothing (and removes an old draft) when the home page is not a known placeholder", () => {
    writeFileSync(home, HOME);
    const file = firstDraftFile(minimal, [sha1Hex(HOME)])!;
    expect(draftStepOf(sh(at(writeFirstDraftCmd(file))))).toBe("written");
    writeFileSync(home, `${HOME}// the engineer's page\n`);
    expect(draftStepOf(sh(at(writeFirstDraftCmd(file))))).toBe("skipped");
    expect(() => readFileSync(join(dir, "first-draft.json"))).toThrow();
    rmSync(home);
    expect(draftStepOf(sh(at(writeFirstDraftCmd(file))))).toBe("skipped");
    expect(writeFirstDraftCmd({ ...file, placeholder_sha1s: ["x'; rm -rf / #"] })).toBe(CLEAR_FIRST_DRAFT_CMD);
  });

  it("reports a failed write instead of failing its caller", () => {
    writeFileSync(home, HOME);
    const out = sh(at(writeFirstDraftCmd(firstDraftFile(minimal, [sha1Hex(HOME)])), "/dev/null/nope"));
    expect(draftStepOf(out)).toBe("failed");
  });
});

describe("the preview's draft plugin (real Vite)", () => {
  let repo = "";
  let draftDir = "";
  const placeholder = zaviStarterProvider.starterFiles().files[DRAFT_HOME_PATH]!;
  const at = (text: string) => text.split(SITE_REPO_DIR).join(repo).split(FIRST_DRAFT_DIR).join(draftDir);
  const draftJson = () => join(draftDir, "first-draft.json");
  const writeDraft = () =>
    execFileSync("bash", ["-c", at(writeFirstDraftCmd(firstDraftFile(buildFirstDraft({ name: "Crumb & Co <img src=x onerror=alert(1)>", idea: "custom cakes", brief: brief([["Hero", "Cakes baked to order"], ["Menu", "Sponges and tarts"]], ["Order a cake", "Pick a day."]) })!)))]);

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "zdraft-vite-")));
    draftDir = join(repo, "..", `${repo.split("/").pop()}-draft`);
    const req = createRequire(join(process.cwd(), "package.json"));
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    symlinkSync(dirname(req.resolve("vite/package.json")), join(repo, "node_modules", "vite"));
    symlinkSync(dirname(req.resolve("react/package.json")), join(repo, "node_modules", "react"));
    mkdirSync(join(repo, "src", "pages"), { recursive: true });
    mkdirSync(join(repo, "src", "zavi"), { recursive: true });
    writeFileSync(join(repo, "src", "zavi", "form.tsx"), "export function usePublicForm() { return { status: 'idle', fields: null, submit() {} }; }\n");
    mkdirSync(join(repo, "src", "components", "sections"), { recursive: true });
    mkdirSync(join(repo, "src", "components", "ui"), { recursive: true });
    writeFileSync(join(repo, "src", "components", "sections", "index.ts"), "export const Hero = () => null; export const CTA = () => null; export const Contact = () => null;\n");
    writeFileSync(join(repo, "src", "components", "ui", "layout.tsx"), "export const Section = () => null; export const Container = () => null; export const SectionHeader = () => null;\n");
    writeFileSync(join(repo, "index.html"), "<!doctype html><html><head></head><body><div id=root></div></body></html>");
    writeFileSync(join(repo, "vite.config.mjs"), "export default {};\n");
    execFileSync("bash", ["-c", at(writeSitePreviewConfigCmd(at(sitePreviewConfigSource())))]);
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(draftDir, { recursive: true, force: true });
  });

  async function serve<T>(fn: (server: import("vite").ViteDevServer) => Promise<T>): Promise<T> {
    const { createServer } = await import("vite");
    const server = await createServer({
      configFile: at(SITE_PREVIEW_CONFIG_PATH),
      root: repo,
      logLevel: "silent",
      server: { middlewareMode: true },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    try {
      return await fn(server);
    } finally {
      await server.close();
    }
  }
  const home = async (server: import("vite").ViteDevServer) => {
    const mods = server.moduleGraph.getModulesByFile(join(repo, DRAFT_HOME_PATH));
    if (mods) for (const m of mods) server.moduleGraph.invalidateModule(m);
    return (await server.transformRequest("/src/pages/Home.tsx"))?.code ?? "";
  };

  it("serves the draft for the untouched placeholder, then the real page the moment it is written", async () => {
    writeFileSync(join(repo, DRAFT_HOME_PATH), placeholder);
    writeDraft();
    await serve(async (server) => {
      expect((server.config.server.hmr as { overlay?: boolean } | undefined)?.overlay).toBe(false);
      const draft = await home(server);
      expect(draft).toContain("data-zavi-first-draft");
      expect(draft).toContain("/src/components/sections");
      expect(draft).toContain(`"${FIRST_DRAFT_MESSAGE}"`);
      expect(draft).toContain('"Cakes baked to order"');
      expect(draft).toContain('"Crumb & Co <img src=x onerror=alert(1)>"');
      expect(draft).not.toContain("dangerouslySetInnerHTML");
      expect(draft).not.toContain("This site is being built");

      writeFileSync(join(repo, DRAFT_HOME_PATH), "export default function Home() { return 'the real page'; }\n");
      const real = await home(server);
      expect(real).toContain("the real page");
      expect(real).not.toContain("data-zavi-first-draft");
    });
  });

  it("never stands in once the draft is cleared, or for a home page that is not the placeholder", async () => {
    writeFileSync(join(repo, DRAFT_HOME_PATH), placeholder);
    writeDraft();
    execFileSync("bash", ["-c", at(CLEAR_FIRST_DRAFT_CMD)]);
    await serve(async (server) => {
      expect((server.config.server.hmr as { overlay?: boolean } | undefined)?.overlay).not.toBe(false);
      expect(await home(server)).toContain("This site is being built");
    });

    writeDraft();
    writeFileSync(join(repo, DRAFT_HOME_PATH), `${placeholder}\n// edited\n`);
    await serve(async (server) => {
      expect(await home(server)).not.toContain("data-zavi-first-draft");
    });
  });

  it("is never part of a production build", async () => {
    writeFileSync(join(repo, DRAFT_HOME_PATH), placeholder);
    writeDraft();
    const { resolveConfig } = await import("vite");
    const built = await resolveConfig({ configFile: at(SITE_PREVIEW_CONFIG_PATH), root: repo, logLevel: "silent" }, "build");
    expect(built.plugins.map((p) => p.name)).not.toContain("zavi-first-draft");
    expect(readFileSync(draftJson(), "utf8")).toContain("Crumb & Co");
  });
});

it("the draft path is outside the repo and outside node_modules", () => {
  expect(FIRST_DRAFT_PATH.startsWith(`${SITE_REPO_DIR}/`)).toBe(false);
  expect(FIRST_DRAFT_PATH).not.toContain("node_modules");
});

describe("clearFirstDraftForSite (a first build settled)", () => {
  const row = (data: unknown, error: { message: string } | null = null) => Promise.resolve({ data, error });
  function deps(o: { box?: unknown; boxErr?: boolean; out?: string; execThrows?: boolean } = {}) {
    const exec = vi.fn(async (_id: string, _cmd: string, _t: number) => {
      if (o.execThrows) throw new Error("sandbox gone");
      return { stdout: o.out ?? "__draft=cleared\n" };
    });
    const findSandbox = vi.fn((_t: string, _r: string) => row(o.box ?? null, o.boxErr ? { message: "x" } : null));
    return { d: { findSandbox, exec }, exec, findSandbox };
  }
  const SITE = { tenant_id: "t1", repo_full_name: "praxis-built/crumb" };

  it("clears the draft in the site's running preview sandbox, looked up under the site's own tenant", async () => {
    const { d, exec, findSandbox } = deps({ box: { e2b_sandbox_id: "sbx-1", preview_status: "live" } });
    expect(await clearFirstDraftForSite(SITE, d)).toBe("cleared");
    expect(findSandbox).toHaveBeenCalledWith("t1", "praxis-built/crumb");
    expect(exec).toHaveBeenCalledWith("sbx-1", CLEAR_FIRST_DRAFT_CMD, 15_000);
  });

  it("never wakes a sandbox whose preview is not running", async () => {
    for (const box of [{ e2b_sandbox_id: "sbx-1", preview_status: "dead" }, { e2b_sandbox_id: "sbx-1", preview_status: null }, { e2b_sandbox_id: null, preview_status: "live" }, null]) {
      const { d, exec } = deps({ box });
      expect(await clearFirstDraftForSite(SITE, d)).toBe("not_running");
      expect(exec).not.toHaveBeenCalled();
    }
  });

  it("never throws", async () => {
    expect(await clearFirstDraftForSite(SITE, deps({ boxErr: true }).d)).toBe("failed");
    expect(await clearFirstDraftForSite(SITE, deps({ box: { e2b_sandbox_id: "s", preview_status: "live" }, execThrows: true }).d)).toBe("failed");
    expect(await clearFirstDraftForSite(SITE, deps({ box: { e2b_sandbox_id: "s", preview_status: "live" }, out: "__draft=failed" }).d)).toBe("failed");
  });
});
