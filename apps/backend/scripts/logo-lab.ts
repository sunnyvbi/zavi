import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

type LogoCase = { name: string; description: string; primary?: string; accent?: string };
type Row = LogoCase & { prompt: string; take: number; svg?: string; model?: string; cost_usd?: number; error?: string; ms: number };

const USAGE = `Usage (from apps/backend):
  npx tsx --env-file=.env scripts/logo-lab.ts --name Rise --desc "a tiered cake drawn with two arcs" [--primary "#8a4b1f"] [--accent "#f3e3cc"] [--n 3]
  npx tsx --env-file=.env scripts/logo-lab.ts --cases cases.json [--n 2]
  cases.json: [{"name":"Rise","description":"...","primary":"#8a4b1f","accent":"#f3e3cc"}, ...]

  --dry     print the model prompt and the price, call nothing (free)
  --yes     actually call the vendor (each take is one paid image.vector call)
  --stub    run the pipeline on the free MEDIA_DEV_STUB logo instead of the vendor
  --out     output folder (default ~/.zavi/logo-lab/<timestamp>)`;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function sheet(rows: Row[]): string {
  const cards = rows
    .map((r) => {
      const art = r.svg
        ? `<div class="tiles"><div class="tile light">${r.svg}</div><div class="tile dark">${r.svg}</div><div class="tile small light"><div class="fav32">${r.svg}</div><div class="fav16">${r.svg}</div></div></div>`
        : `<div class="err">${esc(r.error ?? "no logo")}</div>`;
      const meta = [r.model, r.cost_usd !== undefined ? `$${r.cost_usd.toFixed(3)}` : null, `${(r.ms / 1000).toFixed(1)}s`].filter(Boolean).join(" · ");
      return `<section><h2>${esc(r.name)} <span>take ${r.take}</span></h2><p class="desc">${esc(r.description)}</p>${art}<p class="meta">${esc(meta)}</p><details><summary>Prompt</summary><p>${esc(r.prompt)}</p></details></section>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Logo lab</title><style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;background:#f4f2ee;color:#1a1a1a}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px}
section{background:#fff;border:1px solid #ddd;border-radius:12px;padding:14px}
h2{margin:0;font-size:15px}h2 span{color:#888;font-weight:400}
.desc{color:#555;margin:4px 0 10px}.meta{color:#888;font-size:12px}
.tiles{display:grid;grid-template-columns:1fr 1fr 64px;gap:8px}
.tile{aspect-ratio:1;border-radius:8px;display:flex;align-items:center;justify-content:center;padding:12px}
.tile svg{width:100%;height:100%}.light{background:#fff;border:1px solid #eee}.dark{background:#141414}
.small{flex-direction:column;gap:10px;padding:6px}.fav32 svg{width:32px;height:32px}.fav16 svg{width:16px;height:16px}
.err{color:#b42318;background:#fef3f2;border-radius:8px;padding:12px}
</style></head><body><h1>Logo lab</h1><main>${cards}</main></body></html>`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      desc: { type: "string" },
      primary: { type: "string" },
      accent: { type: "string" },
      cases: { type: "string" },
      n: { type: "string", default: "1" },
      out: { type: "string" },
      dry: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      stub: { type: "boolean", default: false },
    },
  });
  const cases: LogoCase[] = values.cases
    ? JSON.parse(readFileSync(values.cases, "utf8"))
    : values.name && values.desc
      ? [{ name: values.name, description: values.desc, primary: values.primary, accent: values.accent }]
      : [];
  const takes = Math.max(1, Math.min(6, Number(values.n) || 1));
  if (cases.length === 0) {
    console.log(USAGE);
    process.exit(1);
  }
  if (values.stub) process.env.MEDIA_DEV_STUB = "1";
  else delete process.env.MEDIA_DEV_STUB;
  if (values.stub) {
    const { isDevStubbed } = await import("@/services/media-router/dev-stub");
    if (!isDevStubbed("image.vector")) {
      console.error("--stub needs a local (non-production) backend env. Nothing was called.");
      process.exit(1);
    }
  }

  const { siteLogoModelPrompt, liveBuildLogoDeps, prepareGeneratedLogo } = await import("@/services/sites/site-logo-generate");
  const deps = liveBuildLogoDeps();
  const calls = cases.length * takes;
  const first = siteLogoModelPrompt({ site_name: cases[0]!.name, description: cases[0]!.description, primary: cases[0]!.primary, accent: cases[0]!.accent });
  const each = await deps.estimate("image.vector", { prompt: first, aspect_ratio: "1:1" }).catch(() => NaN);
  console.log(`${calls} logo call(s), about $${Number.isFinite(each) ? (each * calls).toFixed(3) : "?"} at the vendor${values.stub ? " (stub: $0)" : ""}.`);
  if (values.dry) {
    for (const c of cases) console.log(`\n${c.name}\n${siteLogoModelPrompt({ site_name: c.name, description: c.description, primary: c.primary, accent: c.accent })}`);
    return;
  }
  if (!values.yes && !values.stub) {
    console.log("Add --yes to spend it, --stub to run free, or --dry to see the prompt only.");
    process.exit(1);
  }

  const out = values.out ?? join(homedir(), ".zavi", "logo-lab", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(out, { recursive: true });
  const rows: Row[] = [];
  for (const c of cases) {
    const prompt = siteLogoModelPrompt({ site_name: c.name, description: c.description, primary: c.primary, accent: c.accent });
    for (let take = 1; take <= takes; take++) {
      const started = Date.now();
      const r = await prepareGeneratedLogo(
        { tenant_id: "logo-lab", site_name: c.name, request: { description: c.description }, primary: c.primary, accent: c.accent, zaviPays: true },
        { ...deps, afford: async () => "ok" },
      ).catch((e: unknown) => ({ reason: String((e as Error)?.message ?? e) }));
      const row: Row = { ...c, prompt, take, ms: Date.now() - started };
      if ("svg" in r) {
        Object.assign(row, { svg: r.svg, model: r.model, cost_usd: r.cost_usd });
        writeFileSync(join(out, `${c.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${take}.svg`), r.svg);
      } else {
        row.error = r.reason;
      }
      rows.push(row);
      console.log(`${c.name} take ${take}: ${row.svg ? `ok ${row.model} $${row.cost_usd?.toFixed(3)}` : `failed: ${row.error}`} (${(row.ms / 1000).toFixed(1)}s)`);
    }
  }
  writeFileSync(join(out, "index.html"), sheet(rows));
  const spent = rows.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  console.log(`\nSpent $${spent.toFixed(3)}. Open ${join(out, "index.html")}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
