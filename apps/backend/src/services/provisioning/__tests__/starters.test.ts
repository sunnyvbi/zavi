import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import ts from "typescript";
import { createElement, type JSX } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildStarterFiles } from "@/services/provisioning/templates/starters";
import { STARTER_CATEGORIES, type StarterCategory } from "@/services/provisioning/starter-picker";
import { TEMPLATE_FILES } from "@/services/provisioning/templates/nextjs-supabase-tailwind/template-files.generated";
import { readBlessedTemplate } from "@/services/agents/codegen-templates";

const BASELINE_PATHS = ["README.md", "LICENSE", ".gitignore", "render.yaml"] as const;

const CATEGORY_EXTRA_PATHS: Record<StarterCategory, readonly string[]> = {
  todo: ["app/components/TodoApp.tsx"],
  blog: ["app/posts/[slug]/page.tsx"],
  dashboard: ["app/components/KpiCard.tsx", "lib/data/mocks.ts"],
  auth: [
    "lib/db.ts",
    "lib/session.ts",
    "lib/auth.ts",
    "scripts/migrate.mjs",
    "app/api/signup/route.ts",
    "app/api/login/route.ts",
    "app/api/logout/route.ts",
    "app/login/page.tsx",
    "app/signup/page.tsx",
    "app/dashboard/page.tsx",
    "app/components/StripInvite.tsx",
  ],
  shop: ["app/components/ProductGrid.tsx", "app/components/CartDrawer.tsx"],
  landing: [
    "app/components/Hero.tsx",
    "app/components/Features.tsx",
    "app/components/Pricing.tsx",
    "app/components/Faq.tsx",
    "app/components/Footer.tsx",
  ],
  generic: [],
};

describe("buildStarterFiles — every category", () => {
  for (const category of STARTER_CATEGORIES) {
    describe(category, () => {
      const files = buildStarterFiles(category);

      it("includes the load-bearing base nextjs files (package.json, app/layout.tsx, etc.)", () => {
        expect(files["package.json"]).toBeDefined();
        expect(files["app/layout.tsx"]).toBeDefined();
        expect(files["app/globals.css"]).toBeDefined();
        expect(files["lib/supabase.ts"]).toBeDefined();
        expect(files["tailwind.config.ts"]).toBeDefined();
        expect(files["postcss.config.mjs"]).toBeDefined();
        expect(files["next.config.mjs"]).toBeDefined();
        expect(files["tsconfig.json"]).toBeDefined();
      });

      it("includes README.md + LICENSE + .gitignore + render.yaml baseline", () => {
        for (const path of BASELINE_PATHS) {
          expect(files[path], `expected ${path} in ${category} starter`).toBeDefined();
          expect(files[path].length).toBeGreaterThan(0);
        }
      });

      it("baseline README mentions 'Built with Zavi' + 'Local dev' + 'Deploy'", () => {
        const readme = files["README.md"];
        expect(readme).toMatch(/Built with \*\*Zavi\*\*/);
        expect(readme).toMatch(/## Local dev/);
        expect(readme).toMatch(/## Deploy/);
      });

      it("baseline README makes no claim about a growth agent or a deploy that has not happened", () => {
        const readme = files["README.md"];
        expect(readme.toLowerCase()).not.toContain("growth agent");
        expect(readme.toLowerCase()).not.toContain("shipped the first deploy");
        expect(buildStarterFiles(category, { visitorSafe: true })["README.md"].toLowerCase()).not.toContain("growth agent");
      });

      it("baseline LICENSE is MIT", () => {
        expect(files.LICENSE).toMatch(/^MIT License/);
        expect(files.LICENSE).toMatch(/Permission is hereby granted/);
      });

      it("baseline .gitignore covers node, next, env, .vercel", () => {
        const ig = files[".gitignore"];
        expect(ig).toMatch(/node_modules/);
        expect(ig).toMatch(/\.next/);
        expect(ig).toMatch(/\.env/);
        expect(ig).toMatch(/\.vercel/);
      });

      it("baseline render.yaml has buildCommand + startCommand", () => {
        const r = files["render.yaml"];
        expect(r).toMatch(/buildCommand:/);
        expect(r).toMatch(/startCommand:/);
      });

      it("includes the category-specific skeleton files", () => {
        for (const path of CATEGORY_EXTRA_PATHS[category]) {
          expect(files[path], `expected ${path} in ${category} starter`).toBeDefined();
          expect(files[path].length).toBeGreaterThan(0);
        }
      });

      it("ships NO secrets in .env.example (KEY= only, no values)", () => {
        const env = files[".env.example"];
        expect(env).toBeDefined();
        for (const line of env.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          expect(trimmed).toMatch(/^[A-Z0-9_]+=$/);
        }
      });

      it("returns a fresh object (mutation does not leak into the base map)", () => {
        const a = buildStarterFiles(category);
        const original = a["README.md"];
        a["README.md"] = "tampered";
        const b = buildStarterFiles(category);
        expect(b["README.md"]).toBe(original);
        expect(TEMPLATE_FILES["package.json"]).toBeDefined();
      });
    });
  }
});

describe("buildStarterFiles — overlay precedence", () => {
  it("category file overrides base (landing replaces app/page.tsx with its hero composition)", () => {
    const landing = buildStarterFiles("landing");
    expect(landing["app/page.tsx"]).toMatch(/Hero/);
    expect(landing["app/page.tsx"]).toMatch(/Pricing/);
    expect(landing["app/page.tsx"]).not.toMatch(/dbReady/);
  });

  it("baseline README overrides both base + category README", () => {
    for (const c of STARTER_CATEGORIES) {
      const f = buildStarterFiles(c);
      expect(f["README.md"]).toMatch(/Built with \*\*Zavi\*\*/);
    }
  });

  it("generic is the safe fallback: base + baseline (+ design system), no category extras", () => {
    const generic = buildStarterFiles("generic");
    expect(generic["app/components/TodoApp.tsx"]).toBeUndefined();
    expect(generic["app/components/Hero.tsx"]).toBeUndefined();
    expect(generic["app/posts/[slug]/page.tsx"]).toBeUndefined();
    for (const path of BASELINE_PATHS) {
      expect(generic[path]).toBeDefined();
    }
  });
});

describe("buildStarterFiles — shadcn/ui design-system baseline (every category)", () => {
  const DESIGN_SYSTEM_PATHS = [
    "lib/utils.ts",
    "components.json",
    "app/components/ui/button.tsx",
  ] as const;

  for (const category of STARTER_CATEGORIES) {
    describe(category, () => {
      const files = buildStarterFiles(category);

      it("ships the design-system foundation files (cn util, components.json, Button)", () => {
        for (const path of DESIGN_SYSTEM_PATHS) {
          expect(files[path], `expected ${path} in ${category} starter`).toBeDefined();
          expect(files[path].length).toBeGreaterThan(0);
        }
      });

      it("lib/utils.ts exports the canonical cn() helper (clsx + tailwind-merge)", () => {
        const utils = files["lib/utils.ts"];
        expect(utils).toMatch(/export function cn/);
        expect(utils).toMatch(/tailwind-merge/);
        expect(utils).toMatch(/clsx/);
      });

      it("Button is a CVA-driven design-system primitive importing cn()", () => {
        const button = files["app/components/ui/button.tsx"];
        expect(button).toMatch(/class-variance-authority/);
        expect(button).toMatch(/buttonVariants/);
        expect(button).toMatch(/@\/lib\/utils/);
      });

      it("package.json carries the base deps AND the shadcn design-system deps", () => {
        const pkg = JSON.parse(files["package.json"]) as {
          dependencies: Record<string, string>;
          devDependencies: Record<string, string>;
        };
        expect(pkg.dependencies.next).toBeDefined();
        expect(pkg.dependencies["@supabase/supabase-js"]).toBeDefined();
        expect(pkg.dependencies.clsx).toBeDefined();
        expect(pkg.dependencies["tailwind-merge"]).toBeDefined();
        expect(pkg.dependencies["class-variance-authority"]).toBeDefined();
        expect(pkg.dependencies["@radix-ui/react-slot"]).toBeDefined();
        expect(pkg.devDependencies["tailwindcss-animate"]).toBeDefined();
        expect(pkg.devDependencies.tailwindcss).toBeDefined();
        expect(pkg.devDependencies.typescript).toBeDefined();
      });

      it("emitted package.json is in sync with the emitted lock (npm ci would run)", () => {
        const pkg = JSON.parse(files["package.json"]) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const lock = JSON.parse(files["package-lock.json"]) as {
          packages?: Record<
            string,
            { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
          >;
        };
        const packages = lock.packages ?? {};
        const root = packages[""] ?? {};
        const rootSpecs: Record<string, string> = { ...root.dependencies, ...root.devDependencies };

        for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
          expect(rootSpecs[name], `${name}: declared in package.json, missing from lock root`).toBe(
            spec,
          );
          expect(
            packages[`node_modules/${name}`],
            `${name}: no resolved entry in the lock`,
          ).toBeDefined();
        }
      });

      it("tailwind.config registers the tailwindcss-animate plugin (so the dep isn't inert)", () => {
        const cfg = files["tailwind.config.ts"];
        expect(cfg).toMatch(/tailwindcss-animate/);
        expect(cfg).toMatch(/plugins:\s*\[animate\]/);
        expect(cfg).toMatch(/\.\/app\/\*\*/);
      });
    });
  }

  const DESIGN_SYSTEM_DEPS = [
    "@radix-ui/react-slot",
    "class-variance-authority",
    "clsx",
    "tailwind-merge",
    "tailwindcss-animate",
  ] as const;

  it("base package.json has ALL design-system deps baked in (merge is a no-op)", () => {
    const basePkg = JSON.parse(TEMPLATE_FILES["package.json"]) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const all = { ...basePkg.dependencies, ...basePkg.devDependencies };
    for (const dep of DESIGN_SYSTEM_DEPS) {
      expect(all[dep], `base package.json must bake in ${dep} to keep npm ci in sync`).toBeDefined();
    }
  });

  it("EVERY seeded dep resolves in the seeded package-lock.json (npm ci would not abort)", () => {
    const files = buildStarterFiles("generic");
    const pkg = JSON.parse(files["package.json"]) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const lock = JSON.parse(files["package-lock.json"]) as {
      packages: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
    };
    const root = lock.packages[""];
    expect(root, "seeded lock must have a root package entry").toBeDefined();
    const lockDeps = { ...(root.dependencies ?? {}), ...(root.devDependencies ?? {}) };
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(lockDeps[dep], `dep ${dep} in package.json is MISSING from package-lock.json root — npm ci will abort`).toBeDefined();
    }
    for (const dep of DESIGN_SYSTEM_DEPS) {
      expect(lock.packages[`node_modules/${dep}`], `lock must resolve node_modules/${dep}`).toBeDefined();
    }
  });
});

describe("auth starter — the site's OWN login (never Zavi's Supabase auth)", () => {
  const files = buildStarterFiles("auth");

  it("ships no Supabase auth calls anywhere", () => {
    for (const [path, content] of Object.entries(files)) {
      if (!/\.(ts|tsx|js|mjs)$/.test(path)) continue;
      expect(content, path).not.toMatch(/\.auth\./);
    }
  });

  it("server code is the blessed templates, byte for byte", () => {
    expect(files["lib/db.ts"]).toBe(readBlessedTemplate("lib-db.ts.template"));
    expect(files["lib/session.ts"]).toBe(readBlessedTemplate("lib-session.ts.template"));
    expect(files["lib/auth.ts"]).toBe(readBlessedTemplate("auth-lib.ts.template"));
    expect(files["app/api/signup/route.ts"]).toBe(readBlessedTemplate("auth-signup-route.ts.template"));
    expect(files["app/api/login/route.ts"]).toBe(readBlessedTemplate("auth-login-route.ts.template"));
    expect(files["app/api/logout/route.ts"]).toBe(readBlessedTemplate("auth-logout-route.ts.template"));
    expect(files["app/api/auth/magic/route.ts"]).toBe(readBlessedTemplate("auth-magic-route.ts.template"));
  });

  it("migrate.mjs creates ONLY the users + roles schema, with the blessed ledger plumbing", () => {
    const m = files["scripts/migrate.mjs"];
    expect(m).toMatch(/id: "0001_users"/);
    expect(m).toMatch(/DO \$\$ BEGIN CREATE TYPE public\.app_role AS ENUM \('user', 'admin'\);\s*EXCEPTION WHEN duplicate_object THEN NULL; END \$\$/);
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS users \(\s*id BIGSERIAL PRIMARY KEY,\s*email TEXT UNIQUE NOT NULL,\s*password_hash TEXT NOT NULL,\s*role public\.app_role NOT NULL DEFAULT 'user',\s*created_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS invites \(\s*id BIGSERIAL PRIMARY KEY,\s*token_hash TEXT UNIQUE NOT NULL,\s*role public\.app_role NOT NULL,\s*created_at TIMESTAMPTZ NOT NULL DEFAULT now\(\),\s*expires_at TIMESTAMPTZ NOT NULL,\s*used_at TIMESTAMPTZ,\s*used_by BIGINT REFERENCES users\(id\),\s*revoked_at TIMESTAMPTZ\s*\)/);
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS _zavi_audit \(\s*id BIGSERIAL PRIMARY KEY,\s*at TIMESTAMPTZ NOT NULL DEFAULT now\(\),\s*event TEXT NOT NULL,\s*actor_user_id BIGINT,\s*target_user_id BIGINT,\s*detail JSONB\s*\)/);
    expect(m).not.toMatch(/favorites/);
    expect(m).toContain("_schema_migrations");
    expect(m).toMatch(/DATABASE_URL unset[\s\S]*process\.exit\(0\)/);
  });

  it("login + signup pages post plain forms to the API routes", () => {
    expect(files["app/login/page.tsx"]).toMatch(/method="post" action="\/api\/login"/);
    expect(files["app/signup/page.tsx"]).toMatch(/method="post" action="\/api\/signup"/);
    for (const page of ["app/login/page.tsx", "app/signup/page.tsx"]) {
      expect(files[page]).toMatch(/name="email"/);
      expect(files[page]).toMatch(/name="password"/);
    }
    expect(files["app/dashboard/page.tsx"]).toMatch(/action="\/api\/logout"/);
  });

  it("the roles schema matches the blessed migrate.mjs example statement for statement", () => {
    const stmts = (src: string) =>
      [...src.matchAll(/`((?:DO \$\$|CREATE TABLE IF NOT EXISTS (?:users|invites|_zavi_audit))[\s\S]*?)`/g)].map((m) => m[1].replace(/\s+/g, " "));
    const starter = stmts(files["scripts/migrate.mjs"]);
    expect(starter).toHaveLength(4);
    expect(starter).toEqual(stmts(readBlessedTemplate("migrate.mjs.template")));
  });

  it("login + signup pages: uncached, no referrer, invite in a hidden field, stripped from the URL", () => {
    for (const page of ["app/login/page.tsx", "app/signup/page.tsx"]) {
      const src = files[page];
      expect(src, page).toMatch(/export const dynamic = "force-dynamic";/);
      expect(src, page).toMatch(/export const metadata: Metadata = \{ referrer: "same-origin" \};/);
      expect(src, page).toMatch(/<StripInvite \/>/);
      expect(src, page).toMatch(/isInviteToken\(searchParams\.invite\)/);
      expect(src, page).not.toMatch(/\{searchParams\.error\}/);
    }
    const strip = files["app/components/StripInvite.tsx"];
    expect(strip.startsWith('"use client";')).toBe(true);
    expect(strip).toMatch(/searchParams\.delete\("invite"\)/);
    expect(strip).toMatch(/window\.history\.replaceState\(/);
  });

  describe("rendered pages (real lib/auth.ts, React server render)", () => {
    const TOKEN = "Abc_-123456789012345678901234567890123456789";
    function loadModule(src: string, mods: Record<string, unknown>): Record<string, unknown> {
      const js = ts.transpileModule(src, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          esModuleInterop: true,
          jsx: ts.JsxEmit.ReactJSX,
        },
      }).outputText;
      const module = { exports: {} as Record<string, unknown> };
      new Function("require", "exports", "module", js)((id: string) => {
        if (id in mods) return mods[id];
        if (id === "react/jsx-runtime") return require("react/jsx-runtime");
        throw new Error(`unmocked import ${id}`);
      }, module.exports, module);
      return module.exports;
    }
    const auth = loadModule(files["lib/auth.ts"], {
      "server-only": {},
      "node:crypto": { createHash },
      "next/headers": { cookies: () => ({ get: () => undefined }) },
      "next/navigation": { redirect: () => undefined, notFound: () => undefined },
      "next/server": { NextResponse: Response },
      bcryptjs: { __esModule: true, default: {} },
      "@/lib/db": { query: async () => ({ rows: [] }), withTransaction: async () => null },
      "@/lib/session": { readSession: () => null },
    });
    const pageMods = {
      "next/link": {
        __esModule: true,
        default: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never),
      },
      "@/app/components/StripInvite": { StripInvite: () => null },
      "@/lib/auth": auth,
    };
    const render = (page: string, searchParams: Record<string, string>) => {
      const Page = loadModule(files[page], pageMods).default as (p: { searchParams: Record<string, string> }) => JSX.Element;
      return renderToStaticMarkup(Page({ searchParams }));
    };

    it("maps ?error codes to fixed copy and never reflects arbitrary text", () => {
      for (const page of ["app/login/page.tsx", "app/signup/page.tsx"]) {
        expect(render(page, { error: "invite" })).toContain(
          "This invite link has expired or was already used. Ask the site owner for a new one.",
        );
        const hostile = render(page, { error: "Your account is locked. Call 555-0100 now" });
        expect(hostile).not.toContain("555-0100");
        expect(hostile).not.toContain('role="alert"');
        expect(render(page, { error: "__proto__" })).not.toContain('role="alert"');
      }
    });

    it("puts a well-formed invite in a hidden field and on the sign-in/sign-up switch link only", () => {
      const html = render("app/signup/page.tsx", { invite: TOKEN });
      expect(html).toContain(`<input type="hidden" name="invite" value="${TOKEN}"/>`);
      expect(html).toContain(`href="/login?invite=${TOKEN}"`);
      expect(html.split(TOKEN)).toHaveLength(3);
      expect(render("app/login/page.tsx", { invite: TOKEN })).toContain(`href="/signup?invite=${TOKEN}"`);
    });

    it("drops a malformed or oversized invite entirely", () => {
      for (const bad of ['"><script>alert(1)</script>', "A".repeat(129), "short"]) {
        const html = render("app/signup/page.tsx", { invite: bad });
        expect(html).not.toContain('name="invite"');
        expect(html).toContain('href="/login"');
        expect(html).not.toContain("script>alert");
      }
    });

    it("the dashboard shows the fixed invite copy for ?error=invite", async () => {
      const users = [{ id: 1, email: "a@b.co", role: "user" }];
      const dashAuth = loadModule(files["lib/auth.ts"], {
        "server-only": {},
        "node:crypto": { createHash },
        "next/headers": { cookies: () => ({ get: () => ({ value: "tok.1" }) }) },
        "next/navigation": { redirect: () => undefined, notFound: () => undefined },
        "next/server": { NextResponse: Response },
        bcryptjs: { __esModule: true, default: {} },
        "@/lib/db": { query: async () => ({ rows: users }), withTransaction: async () => null },
        "@/lib/session": { readSession: () => ({ uid: 1 }) },
      });
      const Dash = loadModule(files["app/dashboard/page.tsx"], {
        "next/navigation": { redirect: () => undefined },
        "@/lib/auth": dashAuth,
      }).default as (p: { searchParams: Record<string, string> }) => Promise<JSX.Element>;
      expect(renderToStaticMarkup(await Dash({ searchParams: { error: "invite" } }))).toContain(
        "This invite link has expired or was already used. Ask the site owner for a new one.",
      );
      expect(renderToStaticMarkup(await Dash({ searchParams: { error: "pay $5 to 555-0100" } }))).not.toContain("555-0100");
    });
  });

  it("ships its OWN package pair: exact pg 8.13.1, bcryptjs, prestart migrate", () => {
    const pkg = JSON.parse(files["package.json"]) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies.pg).toBe("8.13.1");
    expect(pkg.dependencies.bcryptjs).toBe("2.4.3");
    expect(pkg.devDependencies["@types/pg"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies["@types/bcryptjs"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.scripts.prestart).toBe("node scripts/migrate.mjs");
    for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(spec, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    const lock = JSON.parse(files["package-lock.json"]) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };
    expect(lock.packages["node_modules/pg"]?.version).toBe("8.13.1");
    expect(lock.packages["node_modules/bcryptjs"]?.version).toBe("2.4.3");
  });

  it("the base package pair is untouched, and every other category still ships it", () => {
    const basePkg = JSON.parse(TEMPLATE_FILES["package.json"]) as { dependencies: Record<string, string>; scripts: Record<string, string> };
    expect(basePkg.dependencies.pg).toBeUndefined();
    expect(basePkg.scripts.prestart).toBeUndefined();
    for (const c of STARTER_CATEGORIES.filter((x) => x !== "auth")) {
      const f = buildStarterFiles(c);
      expect(f["package.json"], c).toBe(TEMPLATE_FILES["package.json"]);
      expect(f["package-lock.json"], c).toBe(TEMPLATE_FILES["package-lock.json"]);
    }
  });
});
