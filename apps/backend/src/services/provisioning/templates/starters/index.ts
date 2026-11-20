
import { TEMPLATE_FILES, TEMPLATE_VARIANTS } from "../nextjs-supabase-tailwind/template-files.generated";
import { readBlessedTemplate } from "@/services/agents/codegen-templates";
import type { StarterCategory } from "../../starter-picker";

function cloneBase(): Record<string, string> {
  return { ...TEMPLATE_FILES };
}

function overlay(into: Record<string, string>, files: Record<string, string>): Record<string, string> {
  for (const [path, content] of Object.entries(files)) {
    into[path] = content;
  }
  return into;
}

const README_BASELINE = `# Your company app

Built with **Zavi**. Edit, push, and the next deploy goes live.

## Local dev

\`\`\`bash
npm install
cp .env.example .env.local   # fill in your Supabase values
npm run dev                  # http://localhost:3000
\`\`\`

## Deploy

This repo is wired for one-click deploy to either provider:

- **Render** — pushes to the default branch auto-deploy via \`render.yaml\`.
- **Vercel** — \`vercel\` from the repo root, or connect this repo in the
  Vercel dashboard. The default Next.js preset works.

## Environment

| Var | Where | Notes |
| --- | --- | --- |
| \`NEXT_PUBLIC_SUPABASE_URL\` | browser + server | RLS-respecting project URL |
| \`NEXT_PUBLIC_SUPABASE_ANON_KEY\` | browser + server | RLS-respecting anon key |
| \`DATABASE_URL\` | server only | Postgres connection string — never expose to the browser |
`;

const LICENSE_MIT = `MIT License

Copyright (c) ${new Date().getUTCFullYear()} the repository owner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const GITIGNORE_BASELINE = `# Node
node_modules
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# Next.js
.next
out
next-env.d.ts

# Env (never commit secrets)
.env
.env.local
.env.development.local
.env.test.local
.env.production.local
.env*.local

# Vercel
.vercel

# OS / IDE
.DS_Store
Thumbs.db
.idea
.vscode

# Logs
*.log
`;

const RENDER_YAML_PLACEHOLDER = `# render.yaml — placeholder. Zavi provisions Render services via API today,
# but checking this file in lets a maintainer (or a fork) re-deploy without
# touching the dashboard. Edit values to taste before relying on it.
#
# buildCommand MUST stay \`npm ci\`, matching what Zavi sets on the API-created
# service. \`npm ci\` installs only the exact, integrity-hashed artifacts in
# package-lock.json and refuses to run when the lock and package.json disagree;
# \`npm install\` would instead resolve any package NAME straight from the public
# registry and run it in this live app. Weakening it here reopens that hole for
# anyone who deploys from this file.
services:
  - type: web
    name: company-app
    env: node
    plan: starter
    buildCommand: npm ci && npm run build
    startCommand: npm start
    envVars:
      - key: NODE_VERSION
        value: 20.11.1
      - key: NEXT_PUBLIC_SUPABASE_URL
        sync: false
      - key: NEXT_PUBLIC_SUPABASE_ANON_KEY
        sync: false
      - key: DATABASE_URL
        sync: false
`;

function baselineFiles(): Record<string, string> {
  return {
    "README.md": README_BASELINE,
    LICENSE: LICENSE_MIT,
    ".gitignore": GITIGNORE_BASELINE,
    "render.yaml": RENDER_YAML_PLACEHOLDER,
  };
}

function todoFiles(): Record<string, string> {
  return {
    "app/components/TodoApp.tsx": `"use client";

import { useState } from "react";

// TodoApp — skeleton. Engineer agents extend this with persistence
// (Supabase insert/update/delete) and richer UI. The Add/Complete/Delete
// shell exists so the first deploy SHOWS a working interactive list.

type Todo = { id: string; text: string; done: boolean };

export default function TodoApp(): JSX.Element {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [draft, setDraft] = useState("");

  function add(): void {
    const text = draft.trim();
    if (!text) return;
    setTodos((prev) => [...prev, { id: crypto.randomUUID(), text, done: false }]);
    setDraft("");
  }

  function toggle(id: string): void {
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  }

  function remove(id: string): void {
    setTodos((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <section className="mx-auto w-full max-w-md space-y-4">
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="What needs doing?"
          className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={add}
          className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          Add
        </button>
      </div>
      <ul className="space-y-2">
        {todos.map((t) => (
          <li
            key={t.id}
            className="flex items-center justify-between rounded border border-gray-200 px-3 py-2 text-sm"
          >
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={t.done} onChange={() => toggle(t.id)} />
              <span className={t.done ? "text-gray-400 line-through" : "text-gray-900"}>{t.text}</span>
            </label>
            <button
              type="button"
              onClick={() => remove(t.id)}
              className="text-xs text-gray-500 hover:text-red-600"
            >
              Delete
            </button>
          </li>
        ))}
        {todos.length === 0 && (
          <li className="rounded border border-dashed border-gray-300 px-3 py-6 text-center text-sm text-gray-500">
            No tasks yet. Add one above.
          </li>
        )}
      </ul>
    </section>
  );
}
`,
    "app/page.tsx": `import TodoApp from "@/app/components/TodoApp";

export default function Home(): JSX.Element {
  return (
    <main className="flex min-h-screen flex-col items-center justify-start gap-8 px-6 py-16">
      <header className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">Tasks</h1>
        <p className="mt-2 text-sm text-gray-600">A starter to-do app. Extend it.</p>
      </header>
      <TodoApp />
    </main>
  );
}
`,
  };
}

function blogFiles(): Record<string, string> {
  return {
    "app/posts/[slug]/page.tsx": `// Dynamic post route. Engineer agents replace the in-memory map with
// a Supabase-backed query (e.g. \`posts\` table with slug + body_markdown).

const POSTS: Record<string, { title: string; body: string }> = {
  "hello-world": {
    title: "Hello, world",
    body: "This is the first post. Replace this stub with your real data layer.",
  },
};

export function generateStaticParams(): Array<{ slug: string }> {
  return Object.keys(POSTS).map((slug) => ({ slug }));
}

export default function Post({ params }: { params: { slug: string } }): JSX.Element {
  const post = POSTS[params.slug];
  if (!post) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-2xl font-bold">Not found</h1>
        <p className="mt-2 text-sm text-gray-600">No post matches /{params.slug}.</p>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight">{post.title}</h1>
      <article className="prose mt-6 text-gray-800">{post.body}</article>
    </main>
  );
}
`,
    "app/page.tsx": `import Link from "next/link";

const POSTS = [{ slug: "hello-world", title: "Hello, world" }];

export default function Home(): JSX.Element {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-4xl font-bold tracking-tight">Blog</h1>
      <p className="mt-2 text-sm text-gray-600">Starter blog. Add posts.</p>
      <ul className="mt-8 space-y-3">
        {POSTS.map((p) => (
          <li key={p.slug}>
            <Link href={\`/posts/\${p.slug}\`} className="text-blue-700 underline-offset-2 hover:underline">
              {p.title}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
`,
  };
}

function dashboardFiles(): Record<string, string> {
  return {
    "app/components/KpiCard.tsx": `// KpiCard — minimal KPI tile. Engineer agents extend with sparkline /
// delta-vs-prev / drill-in link as the dashboard grows.

type Props = { label: string; value: string; hint?: string };

export default function KpiCard({ label, value, hint }: Props): JSX.Element {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-gray-500">{hint}</div>}
    </div>
  );
}
`,
    "lib/data/mocks.ts": `// Mock data so the dashboard renders before a real data source is wired.
// Engineer agents replace this with a Supabase query or an API call.

export type Kpi = { label: string; value: string; hint?: string };

export function kpis(): Kpi[] {
  return [
    { label: "Revenue", value: "$12,438", hint: "Last 30 days" },
    { label: "Active users", value: "1,204", hint: "DAU" },
    { label: "Conversion", value: "3.4%", hint: "Signup → paid" },
    { label: "Churn", value: "1.1%", hint: "Monthly" },
  ];
}
`,
    "app/page.tsx": `import KpiCard from "@/app/components/KpiCard";
import { kpis } from "@/lib/data/mocks";

export default function Home(): JSX.Element {
  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-600">Starter view. Replace mocks with real data.</p>
      </header>
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis().map((k) => (
          <KpiCard key={k.label} label={k.label} value={k.value} hint={k.hint} />
        ))}
      </section>
    </main>
  );
}
`,
  };
}

function authFiles(): Record<string, string> {
  return {
    "lib/db.ts": readBlessedTemplate("lib-db.ts.template"),
    "lib/session.ts": readBlessedTemplate("lib-session.ts.template"),
    "lib/auth.ts": readBlessedTemplate("auth-lib.ts.template"),
    "app/api/signup/route.ts": readBlessedTemplate("auth-signup-route.ts.template"),
    "app/api/login/route.ts": readBlessedTemplate("auth-login-route.ts.template"),
    "app/api/auth/magic/route.ts": readBlessedTemplate("auth-magic-route.ts.template"),
    "app/api/logout/route.ts": readBlessedTemplate("auth-logout-route.ts.template"),
    "scripts/migrate.mjs": usersOnlyMigrate(),
    "app/components/StripInvite.tsx": STRIP_INVITE,
    "app/login/page.tsx": authPage({
      title: "Sign in",
      action: "/api/login",
      passwordAutoComplete: "current-password",
      submit: "Sign in",
      altText: "No account yet?",
      altHref: "/signup",
      altLink: "Create one",
    }),
    "app/signup/page.tsx": authPage({
      title: "Create your account",
      action: "/api/signup",
      passwordAutoComplete: "new-password",
      submit: "Create account",
      altText: "Already have an account?",
      altHref: "/login",
      altLink: "Sign in",
    }),
    "app/dashboard/page.tsx": `import { redirect } from "next/navigation";
import { authErrorMessage, currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Dashboard({ searchParams }: { searchParams: { error?: string } }): Promise<JSX.Element> {
  const user = await currentUser();
  if (!user) redirect("/login");
  const error = authErrorMessage(searchParams.error);
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-6 py-16">
      <h1 className="text-2xl font-bold tracking-tight">You're signed in</h1>
      <p className="text-sm text-gray-600">{user.email}</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <form method="post" action="/api/logout">
        <button
          type="submit"
          className="w-full rounded bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
`,
  };
}

const STRIP_INVITE = `"use client";
import { useEffect } from "react";

export function StripInvite(): null {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("invite")) return;
    url.searchParams.delete("invite");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, []);
  return null;
}
`;

function usersOnlyMigrate(): string {
  const src = readBlessedTemplate("migrate.mjs.template");
  const start = src.indexOf("const MIGRATIONS = [");
  const end = src.indexOf("// ── end CONFIGURE ME");
  if (start < 0 || end < start) throw new Error("migrate.mjs.template: CONFIGURE ME block not found");
  const users = `const MIGRATIONS = [
  {
    id: "0001_users",
    statements: [
      \`DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('user', 'admin');
       EXCEPTION WHEN duplicate_object THEN NULL; END $$\`,
      \`CREATE TABLE IF NOT EXISTS users (
         id BIGSERIAL PRIMARY KEY,
         email TEXT UNIQUE NOT NULL,
         password_hash TEXT NOT NULL,
         role public.app_role NOT NULL DEFAULT 'user',
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )\`,
      \`CREATE TABLE IF NOT EXISTS invites (
         id BIGSERIAL PRIMARY KEY,
         token_hash TEXT UNIQUE NOT NULL,
         role public.app_role NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         expires_at TIMESTAMPTZ NOT NULL,
         used_at TIMESTAMPTZ,
         used_by BIGINT REFERENCES users(id),
         revoked_at TIMESTAMPTZ
       )\`,
      \`CREATE TABLE IF NOT EXISTS _zavi_audit (
         id BIGSERIAL PRIMARY KEY,
         at TIMESTAMPTZ NOT NULL DEFAULT now(),
         event TEXT NOT NULL,
         actor_user_id BIGINT,
         target_user_id BIGINT,
         detail JSONB
       )\`,
    ],
  },
  {
    id: "0001a_invite_email",
    statements: [\`ALTER TABLE invites ADD COLUMN IF NOT EXISTS email TEXT\`],
  },
  // Append new entries for new tables/columns; never edit 0001_users.
];
`;
  return src.slice(0, start) + users + src.slice(end);
}

function authPage(p: {
  title: string;
  action: string;
  passwordAutoComplete: string;
  submit: string;
  altText: string;
  altHref: string;
  altLink: string;
}): string {
  return `import type { Metadata } from "next";
import Link from "next/link";
import { StripInvite } from "@/app/components/StripInvite";
import { authErrorMessage, isInviteToken } from "@/lib/auth";

// ?invite= carries a secret: never cache this page, never send it to another site as a Referer.
// same-origin (not no-referrer): no-referrer makes browsers send "Origin: null" on this
// page's own form POSTs, which the cross-site guard correctly refuses (403 for every visitor).
export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "same-origin" };

export default function Page({ searchParams }: { searchParams: { error?: string; invite?: string } }): JSX.Element {
  const error = authErrorMessage(searchParams.error);
  const invite = isInviteToken(searchParams.invite) ? searchParams.invite : "";
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-16">
      <StripInvite />
      <h1 className="text-2xl font-bold tracking-tight">${p.title}</h1>
      <form method="post" action="${p.action}" className="mt-6 space-y-3">
        {invite && <input type="hidden" name="invite" value={invite} />}
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
        <input
          name="password"
          type="password"
          autoComplete="${p.passwordAutoComplete}"
          required
          minLength={8}
          placeholder="Password (8+ characters)"
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
        <button
          type="submit"
          className="w-full rounded bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          ${p.submit}
        </button>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      </form>
      <p className="mt-4 text-sm text-gray-600">
        ${p.altText}{" "}
        <Link href={invite ? \`${p.altHref}?invite=\${invite}\` : "${p.altHref}"} prefetch={false} className="font-medium underline">
          ${p.altLink}
        </Link>
      </p>
    </main>
  );
}
`;
}

function shopFiles(): Record<string, string> {
  return {
    "app/components/ProductGrid.tsx": `// Product grid. Engineer agents wire \`products\` to a real source
// (Supabase \`products\` table, Stripe products, etc.) and add filters.

type Product = { id: string; name: string; price: string };

const PRODUCTS: Product[] = [
  { id: "p1", name: "Sample tee", price: "$24" },
  { id: "p2", name: "Sample mug", price: "$12" },
  { id: "p3", name: "Sample tote", price: "$18" },
];

export default function ProductGrid({ onAdd }: { onAdd: (id: string) => void }): JSX.Element {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {PRODUCTS.map((p) => (
        <li key={p.id} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div className="aspect-square rounded bg-gray-100" />
          <div className="mt-3 flex items-baseline justify-between">
            <span className="text-sm font-medium text-gray-900">{p.name}</span>
            <span className="text-sm text-gray-600">{p.price}</span>
          </div>
          <button
            type="button"
            onClick={() => onAdd(p.id)}
            className="mt-3 w-full rounded bg-gray-900 px-3 py-2 text-xs font-medium text-white hover:bg-gray-700"
          >
            Add to cart
          </button>
        </li>
      ))}
    </ul>
  );
}
`,
    "app/components/CartDrawer.tsx": `"use client";

// CartDrawer — slide-in panel that lists added items + a checkout button.
// Engineer agents wire checkout to Stripe Checkout / a server action.

type Props = { items: string[]; open: boolean; onClose: () => void };

export default function CartDrawer({ items, open, onClose }: Props): JSX.Element | null {
  if (!open) return null;
  return (
    <aside className="fixed inset-y-0 right-0 z-50 w-80 border-l border-gray-200 bg-white p-4 shadow-xl">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">Cart</h2>
        <button type="button" onClick={onClose} className="text-xs text-gray-500 hover:text-gray-900">
          Close
        </button>
      </header>
      <ul className="mt-4 space-y-2">
        {items.length === 0 && <li className="text-xs text-gray-500">Your cart is empty.</li>}
        {items.map((id, i) => (
          <li key={\`\${id}-\${i}\`} className="rounded border border-gray-200 px-3 py-2 text-xs text-gray-800">
            {id}
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={items.length === 0}
        className="mt-6 w-full rounded bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
      >
        Checkout
      </button>
    </aside>
  );
}
`,
    "app/page.tsx": `"use client";

import { useState } from "react";
import ProductGrid from "@/app/components/ProductGrid";
import CartDrawer from "@/app/components/CartDrawer";

export default function Home(): JSX.Element {
  const [cart, setCart] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <header className="mb-8 flex items-baseline justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Shop</h1>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          Cart ({cart.length})
        </button>
      </header>
      <ProductGrid onAdd={(id) => setCart((prev) => [...prev, id])} />
      <CartDrawer items={cart} open={open} onClose={() => setOpen(false)} />
    </main>
  );
}
`,
  };
}

function landingFiles(): Record<string, string> {
  return {
    "app/components/Hero.tsx": `export default function Hero(): JSX.Element {
  return (
    <section className="px-6 py-24 text-center">
      <h1 className="mx-auto max-w-3xl text-5xl font-bold tracking-tight text-gray-900 sm:text-6xl">
        Your bold value proposition.
      </h1>
      <p className="mx-auto mt-6 max-w-xl text-lg text-gray-600">
        One sentence that says what you do, who you do it for, and why it matters.
      </p>
      <div className="mt-8 flex justify-center gap-3">
        <a
          href="#pricing"
          className="rounded bg-gray-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-700"
        >
          Get started
        </a>
        <a
          href="#features"
          className="rounded border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-900 hover:bg-gray-50"
        >
          Learn more
        </a>
      </div>
    </section>
  );
}
`,
    "app/components/Features.tsx": `const FEATURES = [
  { title: "Fast", body: "Built on a stack that prioritizes shipping speed." },
  { title: "Flexible", body: "Composable building blocks, no lock-in." },
  { title: "Friendly", body: "Sensible defaults that get out of your way." },
];

export default function Features(): JSX.Element {
  return (
    <section id="features" className="bg-gray-50 px-6 py-20">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-3xl font-bold tracking-tight text-gray-900">Why teams choose us</h2>
        <ul className="mt-10 grid gap-6 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <li key={f.title} className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
              <h3 className="text-base font-semibold text-gray-900">{f.title}</h3>
              <p className="mt-2 text-sm text-gray-600">{f.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
`,
    "app/components/Pricing.tsx": `const TIERS = [
  { name: "Free", price: "$0", tag: "Get started" },
  { name: "Pro", price: "$29", tag: "For growing teams" },
  { name: "Business", price: "$99", tag: "Advanced + priority support" },
];

export default function Pricing(): JSX.Element {
  return (
    <section id="pricing" className="px-6 py-20">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-3xl font-bold tracking-tight text-gray-900">Pricing</h2>
        <ul className="mt-10 grid gap-6 sm:grid-cols-3">
          {TIERS.map((t) => (
            <li key={t.name} className="rounded-lg border border-gray-200 bg-white p-6 text-center shadow-sm">
              <h3 className="text-lg font-semibold text-gray-900">{t.name}</h3>
              <div className="mt-2 text-4xl font-bold text-gray-900">{t.price}</div>
              <p className="mt-2 text-xs text-gray-500">{t.tag}</p>
              <button
                type="button"
                className="mt-6 w-full rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
              >
                Choose {t.name}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
`,
    "app/components/Faq.tsx": `const QA = [
  { q: "How do I get started?", a: "Sign up, create your first project, and follow the onboarding." },
  { q: "Is there a free tier?", a: "Yes — Free works for personal use and side projects." },
  { q: "Can I switch plans later?", a: "Yes, upgrade or downgrade any time from your billing settings." },
];

export default function Faq(): JSX.Element {
  return (
    <section className="bg-gray-50 px-6 py-20">
      <div className="mx-auto max-w-3xl">
        <h2 className="text-3xl font-bold tracking-tight text-gray-900">FAQ</h2>
        <dl className="mt-8 space-y-6">
          {QA.map((qa) => (
            <div key={qa.q}>
              <dt className="text-base font-semibold text-gray-900">{qa.q}</dt>
              <dd className="mt-1 text-sm text-gray-600">{qa.a}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
`,
    "app/components/Footer.tsx": `export default function Footer(): JSX.Element {
  const year = new Date().getUTCFullYear();
  return (
    <footer className="border-t border-gray-200 px-6 py-10 text-center text-xs text-gray-500">
      &copy; {year} Your company. All rights reserved.
    </footer>
  );
}
`,
    "app/page.tsx": `import Hero from "@/app/components/Hero";
import Features from "@/app/components/Features";
import Pricing from "@/app/components/Pricing";
import Faq from "@/app/components/Faq";
import Footer from "@/app/components/Footer";

export default function Home(): JSX.Element {
  return (
    <main>
      <Hero />
      <Features />
      <Pricing />
      <Faq />
      <Footer />
    </main>
  );
}
`,
  };
}

function genericFiles(): Record<string, string> {
  return {};
}

const CATEGORY_GENERATORS: Readonly<Record<StarterCategory, () => Record<string, string>>> = Object.freeze({
  todo: todoFiles,
  blog: blogFiles,
  dashboard: dashboardFiles,
  auth: authFiles,
  shop: shopFiles,
  landing: landingFiles,
  generic: genericFiles,
});

export function buildStarterFiles(
  category: StarterCategory,
  opts: { visitorSafe?: boolean } = {},
): Record<string, string> {
  const gen = CATEGORY_GENERATORS[category] ?? CATEGORY_GENERATORS.generic;
  const out = cloneBase();
  overlay(out, gen());
  overlay(out, packageVariant(category));
  overlay(out, baselineFiles());
  if (opts.visitorSafe === true) out["app/page.tsx"] = VISITOR_SAFE_SEED_PAGE;
  return out;
}

export const VISITOR_SAFE_SEED_PAGE = `export default function Home(): JSX.Element {
  return (
    <main
      data-zavi-seed="placeholder"
      className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Coming soon</h1>
      <p className="max-w-xl text-lg text-gray-600">
        This site is being built. Check back shortly.
      </p>
    </main>
  );
}
`;

function packageVariant(category: StarterCategory): Record<string, string> {
  const v = TEMPLATE_VARIANTS[category];
  if (!v) return {};
  const pkg = v["package.json"];
  const lock = v["package-lock.json"];
  if (!pkg || !lock) throw new Error(`starter variant ${category} must ship package.json AND package-lock.json`);
  return { "package.json": pkg, "package-lock.json": lock };
}
