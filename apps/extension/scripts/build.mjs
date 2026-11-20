
import { build, context } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.ZAVI_BUILD_OUT ? resolve(process.env.ZAVI_BUILD_OUT) : resolve(ROOT, "dist");
const WATCH = process.argv.includes("--watch");

loadDotEnvLocal();

const API_BASE = process.env.ZAVI_API_BASE ?? "https://api.zaviagent.com";
const WEB_BASE = process.env.ZAVI_WEB_BASE ?? "https://www.zaviagent.com";
const SUPABASE_URL =
  process.env.ZAVI_SUPABASE_URL ?? "https://wmycgyjsenvgtczlupoe.supabase.co";
const SUPABASE_ANON_KEY = process.env.ZAVI_SUPABASE_ANON_KEY;

if (!SUPABASE_ANON_KEY) {
  fail(
    "ZAVI_SUPABASE_ANON_KEY is not set.\n" +
      "Put it in apps/extension/.env.local (gitignored) or export it:\n" +
      "  ZAVI_SUPABASE_ANON_KEY=<anon key> npm run build -w @zavi/extension\n" +
      "The anon key is the PUBLISHABLE key — the same one apps/web ships. " +
      "Never use the service-role key.",
  );
}

assertNotServiceRole(SUPABASE_ANON_KEY);

const define = {
  __ZAVI_API_BASE__: JSON.stringify(API_BASE),
  __ZAVI_WEB_BASE__: JSON.stringify(WEB_BASE),
  __ZAVI_SUPABASE_URL__: JSON.stringify(SUPABASE_URL),
  __ZAVI_SUPABASE_ANON_KEY__: JSON.stringify(SUPABASE_ANON_KEY),
  "process.env.NODE_ENV": JSON.stringify(
    process.env.NODE_ENV ?? (WATCH ? "development" : "production"),
  ),
};

const common = {
  bundle: true,
  define,
  external: ["*.woff2"],
  target: ["chrome116"],
  logLevel: "info",
  legalComments: "none",
  sourcemap: WATCH ? "inline" : false,
  minify: !WATCH,
};

async function run() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const jobs = [
    {
      ...common,
      entryPoints: { panel: resolve(ROOT, "src/panel/index.tsx") },
      outdir: OUT,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
    },
    {
      ...common,
      entryPoints: { "service-worker": resolve(ROOT, "src/background/service-worker.ts") },
      outdir: OUT,
      format: "esm",
      platform: "browser",
    },
  ];

  if (WATCH) {
    const ctxs = await Promise.all(jobs.map((j) => context(j)));
    copyStatic();
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log(`[zavi] watching — output in ${OUT}`);
    return;
  }

  for (const job of jobs) await build(job);
  copyStatic();
  console.log(`[zavi] built → ${OUT}`);
}

function copyStatic() {
  cpSync(resolve(ROOT, "public"), OUT, { recursive: true });
}

function loadDotEnvLocal() {
  const file = resolve(ROOT, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function assertNotServiceRole(key) {
  if (key.startsWith("sb_secret_")) {
    fail(
      "ZAVI_SUPABASE_ANON_KEY is an sb_secret_ key. That is the SECRET " +
        "(service-role) key — it must never reach client code. Use the " +
        "sb_publishable_ key. Refusing to build.",
    );
  }
  const parts = key.split(".");
  if (parts.length !== 3) return;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (payload?.role && payload.role !== "anon") {
      fail(
        `ZAVI_SUPABASE_ANON_KEY carries role "${payload.role}". ` +
          "Only the anon key may be bundled into client code. Refusing to build.",
      );
    }
  } catch {
  }
}

function fail(msg) {
  console.error(`\n[zavi] ${msg}\n`);
  process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
