import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE_MANIFEST_PATH, SMOKE_SCRIPT_PATH, VITE_DEV_PORT } from "@/services/sites/contract";
import { COPY_BANNER, collectTemplateFiles, renderModule, sharedCopies } from "../generate-template-files";
import { TEMPLATE_FILES, TEMPLATE_FILE_PATHS } from "../template-files.generated";
import { ZAVI_STARTER_LOCKFILE_COMMAND, createZaviStarterProvider, zaviStarterProvider } from "../index";
import { TEMPLATE_FILES as SUPABASE_STARTER } from "../../vite-react-supabase/template-files.generated";
import { forbiddenSitePaths, validateManifest } from "../manifest";
import { DEFAULT_THEME_PRESET, THEME_CSS_PATH, getThemePreset, renderThemeCss } from "../theme-presets";

const HERE = __dirname;
const GENERATED = join(HERE, "..", "template-files.generated.ts");
const HAS_LOCK = existsSync(join(HERE, "..", "files", "package-lock.json"));
const EXACT = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
const APP_FILES = TEMPLATE_FILE_PATHS.filter((p) => /\.(ts|tsx|js|mjs|json|html)$/.test(p) && p !== "package-lock.json");

describe("vite-react-zavi starter: generated module", () => {
  it("the committed generated module matches ./files (re-run generate-template-files.ts if this fails)", () => {
    expect(readFileSync(GENERATED, "utf-8")).toBe(renderModule(collectTemplateFiles()));
  });

  it("the starter's src/zavi/manifest is an exact copy of packages/site-manifest/src", () => {
    const copies = sharedCopies();
    expect(copies.map((c) => c.name)).toEqual(expect.arrayContaining(["index.ts", "manifest.ts", "rules.ts", "diff.ts", "sha256.ts", "canonical.ts"]));
    for (const c of copies) {
      expect(TEMPLATE_FILES[`src/zavi/manifest/${c.name}`], c.name).toBe(c.content);
      expect(c.content.startsWith(COPY_BANNER)).toBe(true);
    }
    const shipped = TEMPLATE_FILE_PATHS.filter((p) => p.startsWith("src/zavi/manifest/"));
    expect(shipped).toHaveLength(copies.length);
  });

  it("freezes the file map", () => {
    expect(Object.isFrozen(TEMPLATE_FILES)).toBe(true);
    expect(Object.isFrozen(TEMPLATE_FILE_PATHS)).toBe(true);
  });
});

describe("vite-react-zavi starter: required files", () => {
  const required = [
    "package.json", "index.html", "vite.config.ts", "tsconfig.json", "tailwind.config.ts", "postcss.config.js",
    ".gitignore", "CLAUDE.md", "README.md", "dev-seed.json", SITE_MANIFEST_PATH, SMOKE_SCRIPT_PATH, "scripts/check-manifest.mjs",
    "src/main.tsx", "src/App.tsx", "src/index.css", "src/vite-env.d.ts",
    "src/zavi/index.ts", "src/zavi/client.ts", "src/zavi/errors.ts", "src/zavi/react.ts", "src/zavi/devstore.ts", "src/zavi/local.ts",
    "src/pages/Home.tsx", "src/pages/Login.tsx", "src/pages/Admin.tsx", "src/pages/Account.tsx", "src/pages/Confirm.tsx", "src/zavi/confirm.ts",
    THEME_CSS_PATH, "src/site.ts", "src/lib/utils.ts", "src/components/sections/index.ts", "src/components/ui/button.tsx",
    "src/components/ui/layout.tsx", "src/components/ui/image.tsx", "src/components/ui/reveal.tsx",
  ];
  it.each(required)("ships %s", (p) => {
    expect(TEMPLATE_FILE_PATHS).toContain(p);
  });

  it("routes / /login /admin /account /auth/confirm /auth/sign-in", () => {
    for (const route of ['path="/"', 'path="/login"', 'path="/admin"', 'path="/account"', 'path="/auth/confirm"', 'path="/auth/sign-in"']) {
      expect(TEMPLATE_FILES["src/App.tsx"]).toContain(route);
    }
  });

  it("vite dev server is reachable through the e2b preview host on the contract port, and the build validates the manifest", () => {
    const cfg = TEMPLATE_FILES["vite.config.ts"];
    expect(cfg).toContain("host: true");
    expect(cfg).toContain('allowedHosts: [".e2b.app"]');
    expect(cfg).toContain(`port: ${VITE_DEV_PORT}`);
    expect(cfg).toContain("strictPort: true");
    expect(cfg).toContain("validateManifest");
  });

  it("README says the lockfile is generated in e2b", () => {
    expect(TEMPLATE_FILES["README.md"]).toContain(ZAVI_STARTER_LOCKFILE_COMMAND.replace("npx tsx ", ""));
  });

  it("leaves the vite-react-supabase starter untouched (it still ships its SQL)", () => {
    expect(SUPABASE_STARTER["supabase/starter.sql"]).toBeDefined();
  });
});

describe("vite-react-zavi starter: no SQL, no database client, no keys", () => {
  it("ships no SQL and nothing under supabase/", () => {
    expect(forbiddenSitePaths(TEMPLATE_FILE_PATHS)).toEqual([]);
  });

  it("no app file uses supabase-js, a database URL or a key", () => {
    for (const p of APP_FILES) {
      const src = TEMPLATE_FILES[p];
      expect(src, p).not.toMatch(/@supabase\/supabase-js|createClient\(|supabase\.co|service_role|VITE_SUPABASE/i);
    }
  });

  it("no .env file: the browser needs no configuration at all", () => {
    expect(TEMPLATE_FILE_PATHS.filter((p) => p.startsWith(".env"))).toEqual([]);
    for (const p of APP_FILES) expect(TEMPLATE_FILES[p], p).not.toMatch(/import\.meta\.env\.VITE_/);
  });

  it("app code reaches /api only through the SDK", () => {
    for (const p of APP_FILES.filter((x) => x.startsWith("src/") && !x.startsWith("src/zavi/"))) {
      expect(TEMPLATE_FILES[p], p).not.toMatch(/fetch\(|["'`]\/api\//);
    }
  });
});

describe("vite-react-zavi starter: CLAUDE.md teaches the SDK, not SQL", () => {
  const md = TEMPLATE_FILES["CLAUDE.md"];
  it("declares collections in zavi-site.json and uses zavi.data", () => {
    expect(md).toContain("zavi-site.json");
    expect(md).toContain('zavi.data.collection("x")');
    expect(md).toContain("npm run check");
    expect(md).toMatch(/`anyone` may never `update` or `delete`/);
    expect(md).toContain("data-zavi");
  });
  it("forbids SQL and supabase-js, and never teaches either", () => {
    expect(md).toMatch(/never add `supabase\/`, `\.sql` files, `@supabase\/supabase-js`/);
    expect(md).not.toMatch(/create table|enable row level security|migrations\//i);
  });
  it("stays within its size budget", () => {
    expect(md.length).toBeLessThanOrEqual(11_500);
  });
  it("has a Design section that points at the theme file and the section library", () => {
    const design = md.slice(md.indexOf("## Design"));
    expect(md).toContain("## Design");
    expect(design).toContain("`src/theme.css` is written by the platform from the chosen design direction. Never edit it.");
    expect(design).toContain("../components/sections");
    expect(design).toContain("lucide-react");
    expect(design).toContain("public/images/");
  });
});

describe("vite-react-zavi starter: design system", () => {
  const SRC = TEMPLATE_FILE_PATHS.filter((p) => p.startsWith("src/") && !p.startsWith("src/zavi/") && /\.(ts|tsx)$/.test(p));
  const pkg = JSON.parse(TEMPLATE_FILES["package.json"]);
  const deps = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));

  it("ships the default preset's theme.css, imported before index.css", () => {
    const preset = getThemePreset(DEFAULT_THEME_PRESET);
    expect(preset).toBeDefined();
    expect(TEMPLATE_FILES[THEME_CSS_PATH]).toBe(renderThemeCss(preset!));
    const main = TEMPLATE_FILES["src/main.tsx"];
    expect(main.indexOf('import "./theme.css"')).toBeGreaterThan(-1);
    expect(main.indexOf('import "./theme.css"')).toBeLessThan(main.indexOf('import "./index.css"'));
  });

  it("every relative import in the starter resolves to a shipped file", () => {
    const missing: string[] = [];
    for (const p of SRC) {
      const dir = p.split("/").slice(0, -1).join("/");
      for (const m of TEMPLATE_FILES[p].matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']|import\s+["'](\.{1,2}\/[^"']+)["']/g)) {
        const spec = m[1] ?? m[2];
        const parts = [...dir.split("/"), ...spec.split("/")].reduce<string[]>((acc, seg) => {
          if (seg === "..") acc.pop();
          else if (seg !== ".") acc.push(seg);
          return acc;
        }, []);
        const base = parts.join("/");
        const hit = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].some((c) => c in TEMPLATE_FILES);
        if (!hit) missing.push(`${p} -> ${spec}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("imports only declared packages, and no Radix or other UI kit", () => {
    const bad: string[] = [];
    for (const p of SRC) {
      for (const m of TEMPLATE_FILES[p].matchAll(/from\s+["']([^."'][^"']*)["']/g)) {
        const spec = m[1];
        if (spec.startsWith("@/")) continue;
        const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        if (spec.startsWith("@radix-ui/") || !deps.has(name)) bad.push(`${p} -> ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the @/ alias is declared for both TypeScript and Vite", () => {
    expect(JSON.parse(TEMPLATE_FILES["tsconfig.json"]).compilerOptions.paths).toEqual({ "@/*": ["src/*"] });
    expect(TEMPLATE_FILES["vite.config.ts"]).toMatch(/alias: \{ "@": /);
  });

  it("keeps the token classes other platform code renders with", () => {
    const tw = TEMPLATE_FILES["tailwind.config.ts"];
    for (const t of ["background", "foreground", "primary", "muted", "border", "danger"]) expect(tw).toContain(`token("${t}")`);
    expect(tw).toContain('foreground: token("primary-foreground")');
    expect(tw).toContain('foreground: token("muted-foreground")');
  });
});

describe("vite-react-zavi starter: dependencies", () => {
  const pkg = JSON.parse(TEMPLATE_FILES["package.json"]);
  it("every dependency is exact-pinned, with no supabase-js", () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.entries(all).filter(([, v]) => !EXACT.test(String(v)))).toEqual([]);
    expect(all["@supabase/supabase-js"]).toBeUndefined();
    expect(pkg.dependencies["react-router-dom"]).toBeDefined();
    expect(pkg.devDependencies.playwright).toBeDefined();
  });
  it("has dev, build, typecheck, check and smoke scripts", () => {
    expect(pkg.scripts.dev).toContain("vite");
    expect(pkg.scripts.build).toContain("vite build");
    expect(pkg.scripts.typecheck).toContain("tsc");
    expect(pkg.scripts.check).toBe("node scripts/check-manifest.mjs");
    expect(pkg.scripts.smoke).toBe(`node ${SMOKE_SCRIPT_PATH}`);
  });
  it.skipIf(!HAS_LOCK)("package-lock.json satisfies package.json", () => {
    const lock = JSON.parse(TEMPLATE_FILES["package-lock.json"]);
    const rootSpecs = { ...lock.packages[""].dependencies, ...lock.packages[""].devDependencies };
    for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(rootSpecs[name], name).toBe(spec);
    }
  });
  const STARTER_ONLY = ["node_modules/class-variance-authority", "node_modules/clsx", "node_modules/lucide-react", "node_modules/tailwind-merge"];
  it.skipIf(!HAS_LOCK)("package-lock.json is the supabase starter's lock minus supabase packages plus the design kit (no drift, npmjs only)", () => {
    const lock = JSON.parse(TEMPLATE_FILES["package-lock.json"]);
    const seed = JSON.parse(SUPABASE_STARTER["package-lock.json"]);
    expect(lock.lockfileVersion).toBe(3);
    const added = Object.keys(lock.packages).filter((p) => p !== "" && !seed.packages[p]);
    expect(added.sort()).toEqual(STARTER_ONLY);
    for (const p of STARTER_ONLY) {
      const e = lock.packages[p] as { version: string; resolved: string; integrity: string; dependencies?: Record<string, string> };
      expect(e.version, p).toBe(pkg.dependencies[p.slice("node_modules/".length)]);
      expect(e.resolved, p).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(e.integrity, p).toMatch(/^sha512-/);
      for (const dep of Object.keys(e.dependencies ?? {})) expect(lock.packages[`node_modules/${dep}`], `${p} needs ${dep}`).toBeDefined();
    }
    for (const [path, entry] of Object.entries(lock.packages as Record<string, { version?: string; resolved?: string; integrity?: string }>)) {
      if (path === "" || STARTER_ONLY.includes(path)) continue;
      expect(seed.packages[path], path).toBeDefined();
      expect({ v: entry.version, r: entry.resolved, i: entry.integrity }, path).toEqual({
        v: seed.packages[path].version, r: seed.packages[path].resolved, i: seed.packages[path].integrity,
      });
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry.integrity, path).toMatch(/^sha512-/);
    }
  });
});

describe("vite-react-zavi starter: manifest", () => {
  const m = validateManifest(TEMPLATE_FILES[SITE_MANIFEST_PATH]);
  it("is valid and its submissions collection (the public form) keeps visitor data admin-only", () => {
    if (!m.ok) throw new Error(JSON.stringify(m.issues));
    const c = m.value.collections.submissions;
    expect(c.rules).toEqual({ list: ["owner", "admin"], get: ["owner", "admin"], create: ["anyone"], update: ["admin"], delete: ["admin"] });
  });
  it("its smoke journeys create, read back as admin, and deny a visitor", () => {
    const journeys = JSON.parse(TEMPLATE_FILES[SITE_MANIFEST_PATH]).smoke.journeys as Array<Record<string, unknown>>;
    expect(journeys.map((j) => j.name)).toEqual(["home", "login", "contact-create", "visitor-denied", "admin-sees-message"]);
    expect(JSON.stringify(journeys)).toContain('"deniedRead":"submissions"');
    expect(journeys.find((j) => j.name === "admin-sees-message")).toMatchObject({ as: "owner", needs: "contact-create" });
  });
  it("every data-zavi hook the journeys use exists in the pages", () => {
    const src = Object.entries(TEMPLATE_FILES)
      .filter(([p]) => p.startsWith("src/") && !p.startsWith("src/zavi/") && p.endsWith(".tsx"))
      .map(([, c]) => c)
      .join("\n");
    const hooks = TEMPLATE_FILES[SITE_MANIFEST_PATH].match(/data-zavi=[a-z0-9-]+/g) ?? [];
    for (const h of hooks) expect(src, h).toContain(`data-zavi="${h.split("=")[1]}"`);
  });
  it("the dev seed matches the manifest and has an admin", () => {
    const seed = JSON.parse(TEMPLATE_FILES["dev-seed.json"]);
    expect(seed.users.some((u: { role?: string }) => u.role === "admin")).toBe(true);
    for (const c of Object.keys(seed.records)) expect(m.ok && m.value.collections[c]).toBeTruthy();
  });
  it("the SDK is exposed to the smoke check as window.__zavi", () => {
    expect(TEMPLATE_FILES["src/zavi/index.ts"]).toContain("__zavi = zavi");
  });
  it("dev mode only in the dev server: the production build talks to the gateway", () => {
    const src = TEMPLATE_FILES["src/zavi/index.ts"];
    expect(src).toMatch(/if \(import\.meta\.env\.DEV\)/);
    expect(src).toContain('fetchFn("/api/site"');
  });
});

describe("zaviStarterProvider (SiteStarterProvider)", () => {
  const withLock = { ...TEMPLATE_FILES, "package-lock.json": "{}" };
  it("returns the file map, the manifest and NO starter SQL", () => {
    const out = createZaviStarterProvider(withLock).starterFiles();
    expect(out.files).toEqual(withLock);
    expect(out.starter_sql).toBe("");
    expect(out.manifest_json).toBe(TEMPLATE_FILES[SITE_MANIFEST_PATH]);
  });
  it("returns a copy, so a caller cannot mutate the embedded map", () => {
    const out = createZaviStarterProvider(withLock).starterFiles();
    out.files["package.json"] = "tampered";
    expect(createZaviStarterProvider(withLock).starterFiles().files["package.json"]).toBe(TEMPLATE_FILES["package.json"]);
  });
  it("refuses to seed a repo without a lockfile", () => {
    const { ["package-lock.json"]: _drop, ...noLock } = withLock;
    expect(() => createZaviStarterProvider(noLock).starterFiles()).toThrow(ZAVI_STARTER_LOCKFILE_COMMAND);
  });
  it("the default provider matches the lockfile state on disk", () => {
    if (HAS_LOCK) expect(zaviStarterProvider.starterFiles().files["package-lock.json"]).toBeDefined();
    else expect(() => zaviStarterProvider.starterFiles()).toThrow(ZAVI_STARTER_LOCKFILE_COMMAND);
  });
});
