
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GH = "https://api.github.com";
const RENDER = "https://api.render.com/v1";
export const ENV_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const SEED_SUPABASE_PATH = "lib/supabase.ts";
const CODE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;
const SKIP_DIR = /(?:^|\/)(?:node_modules|\.next)\//;

export function gitBlobSha(content) {
  const buf = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

const HISTORICAL_SEED_SUPABASE_SHAS = [
  "0408b064d8293ef4bc4e3c7a587f93fa0fb2f9b5",
  "a6223f5006a5fe37050acb875c44b9570fb1bda7",
];
export function seedSupabaseShas() {
  const s = new Set(HISTORICAL_SEED_SUPABASE_SHAS);
  try {
    s.add(
      gitBlobSha(
        readFileSync(
          join(HERE, "../src/services/provisioning/templates/nextjs-supabase-tailwind/files/lib/supabase.ts"),
          "utf8",
        ),
      ),
    );
  } catch {
  }
  return s;
}

const CONFIG_ONLY_NAMES = new Set(["hasSupabaseConfig", "databaseUrl"]);
const SUPABASE_AUTH_CALL = /\.auth\s*\.\s*[A-Za-z_]/;
const DATA_CALL = /\.(?:from|rpc|channel)\s*\(|\.storage\s*\./;
const OWN_ENV_READ = /NEXT_PUBLIC_SUPABASE_(?:URL|ANON_KEY)/;
const IMPORT_RE = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function isSupabaseModule(spec) {
  return spec.startsWith("@supabase/") || /(?:^|\/)supabase(?:\.[cm]?[tj]sx?)?$/i.test(spec);
}

export function classifyFile(path, content) {
  const src = String(content ?? "");
  const mentions = /supabase/i.test(src);
  if (!mentions) return { signal: null, why: "" };
  if (SUPABASE_AUTH_CALL.test(src)) return { signal: "auth", why: `${path}: supabase .auth. call` };
  if (OWN_ENV_READ.test(src)) return { signal: "data", why: `${path}: reads NEXT_PUBLIC_SUPABASE_* itself` };
  const imports = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[2] ?? m[3];
    if (spec && isSupabaseModule(spec)) imports.push({ spec, clause: m[1] ?? null });
  }
  if (imports.length === 0) {
    return DATA_CALL.test(src) && /supabase\s*[.?]/i.test(src)
      ? { signal: "data", why: `${path}: supabase data call` }
      : { signal: null, why: "" };
  }
  for (const { spec, clause } of imports) {
    if (spec.startsWith("@supabase/")) return { signal: "data", why: `${path}: imports ${spec}` };
    const names = namedImports(clause);
    if (!names || names.some((n) => !CONFIG_ONLY_NAMES.has(n))) {
      return { signal: "data", why: `${path}: uses the supabase client (${clause ?? "require"})` };
    }
  }
  return { signal: "config", why: `${path}: only ${[...CONFIG_ONLY_NAMES].join("/")} (env-presence pill)` };
}

function namedImports(clause) {
  if (!clause) return null;
  const m = clause.trim().match(/^\{([\s\S]*)\}$/);
  if (!m) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0])
    .filter(Boolean);
}

export function classifySite({ tree, files, seedShas }) {
  const reasons = [];
  let auth = false;
  let data = false;
  let configPill = false;
  for (const entry of tree) {
    if (entry.type !== "blob" || !CODE_EXT.test(entry.path) || SKIP_DIR.test(entry.path)) continue;
    if (entry.path === SEED_SUPABASE_PATH && seedShas.has(entry.sha)) continue;
    const content = files.get(entry.path);
    if (content === undefined) return { cls: "unknown", reasons: [`${entry.path}: not read`], configPill };
    if (entry.path === SEED_SUPABASE_PATH) {
      const r = classifyFile(entry.path, content);
      if (r.signal === "auth") auth = true;
      else data = true;
      reasons.push(`${entry.path}: seed lib/supabase.ts was modified`);
      continue;
    }
    const r = classifyFile(entry.path, content);
    if (r.signal === "auth") auth = true;
    if (r.signal === "data") data = true;
    if (r.signal === "config") configPill = true;
    if (r.signal && r.signal !== "config") reasons.push(r.why);
  }
  const cls = auth ? "auth" : data ? "non_auth_supabase" : "base_only";
  return { cls, reasons, configPill };
}

export function setDigest(ids) {
  return createHash("sha256").update([...ids].sort().join(",")).digest("hex").slice(0, 8);
}

function ghClient(token) {
  const blobCache = new Map();
  let remaining = Infinity;
  async function gh(path) {
    if (remaining < 25) throw new Error("GitHub rate limit nearly exhausted; stopping reads");
    const res = await fetch(`${GH}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    const rem = Number(res.headers.get("x-ratelimit-remaining"));
    if (Number.isFinite(rem)) remaining = rem;
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
    return res.json();
  }
  return {
    get remaining() {
      return remaining;
    },
    async readSite(fullName) {
      const repo = await gh(`/repos/${fullName}`);
      const branch = repo.default_branch;
      if (!branch) throw new Error("repo has no default branch");
      const t = await gh(`/repos/${fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      if (t.truncated) throw new Error("tree truncated by GitHub (too large to walk fully)");
      const tree = (t.tree ?? []).map((e) => ({ path: e.path, sha: e.sha, type: e.type }));
      const files = new Map();
      for (const e of tree) {
        if (e.type !== "blob" || !CODE_EXT.test(e.path) || SKIP_DIR.test(e.path)) continue;
        if (!blobCache.has(e.sha)) {
          const b = await gh(`/repos/${fullName}/git/blobs/${e.sha}`);
          if (b.encoding !== "base64") throw new Error(`blob ${e.path}: unexpected encoding ${b.encoding}`);
          blobCache.set(e.sha, Buffer.from(b.content, "base64").toString("utf8"));
        }
        files.set(e.path, blobCache.get(e.sha));
      }
      return { branch, tree, files };
    },
  };
}

async function renderEnvKeys(renderKey, serviceId) {
  if (!renderKey) return null;
  const present = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ limit: "100" });
    if (cursor) q.set("cursor", cursor);
    const res = await fetch(`${RENDER}/services/${serviceId}/env-vars?${q}`, {
      headers: { authorization: `Bearer ${renderKey}`, accept: "application/json" },
    });
    if (res.status !== 200) throw new Error(`render env-vars ${serviceId} -> HTTP ${res.status}`);
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const item of arr) {
      const k = item?.envVar?.key;
      if (ENV_KEYS.includes(k)) present.push(k);
    }
    cursor = arr[arr.length - 1]?.cursor ?? null;
    if (!cursor || arr.length < 100) break;
  }
  return present;
}

async function readAllRows(sb, kind) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("tenant_resources")
      .select("id,tenant_id,provider,mode,status,external_ref")
      .eq("resource_kind", kind)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`tenant_resources(${kind}) read failed: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return rows;
}

async function loadSites(sb) {
  const hosting = (await readAllRows(sb, "hosting")).filter((r) => r.status === "ready");
  const repoByTenant = new Map();
  for (const r of await readAllRows(sb, "repo")) {
    if (r.status === "torn_down" || r.status === "teardown") continue;
    repoByTenant.set(r.tenant_id, r);
  }
  const tenantIds = [...new Set(hosting.map((h) => h.tenant_id))];
  const tenants = new Map();
  for (let i = 0; i < tenantIds.length; i += 200) {
    const { data, error } = await sb.from("tenants").select("id,slug,kind").in("id", tenantIds.slice(i, i + 200));
    if (error) throw new Error(`tenants read failed: ${error.message}`);
    for (const t of data ?? []) tenants.set(t.id, t);
  }
  return hosting.map((h) => {
    const repo = repoByTenant.get(h.tenant_id) ?? null;
    const t = tenants.get(h.tenant_id);
    return {
      hosting_row_id: h.id,
      tenant_id: h.tenant_id,
      slug: t?.slug ?? null,
      tenant_kind: t?.kind ?? null,
      service_id: h.external_ref?.render_service_id ?? null,
      url: h.external_ref?.url ?? null,
      repo: repo?.external_ref?.github_full_name ?? null,
      repo_mode: repo?.mode ?? null,
      user_repo_grant: repo?.external_ref?.user_repo_grant === true,
    };
  });
}

async function classifyOne(site, ghc, seedShas, renderKey) {
  const out = { ...site, class: "unknown", reasons: [], config_pill: false, env_keys_present: null, branch: null };
  if (!site.service_id) {
    out.reasons.push("hosting row has no render_service_id");
    return out;
  }
  if (!site.repo) {
    out.reasons.push("no live repo row for this tenant");
    return out;
  }
  try {
    const { branch, tree, files } = await ghc.readSite(site.repo);
    out.branch = branch;
    const r = classifySite({ tree, files, seedShas });
    out.class = r.cls;
    out.reasons = r.reasons;
    out.config_pill = r.configPill;
  } catch (e) {
    out.class = "unknown";
    out.reasons = [`read error: ${e.message}`];
  }
  try {
    out.env_keys_present = await renderEnvKeys(renderKey, site.service_id);
  } catch (e) {
    out.env_keys_present = null;
    out.reasons.push(`render env read failed: ${e.message}`);
  }
  return out;
}

function writeReport(outDir, results, digest) {
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(outDir, `app-supabase-cleanup-${stamp}`);
  const counts = {};
  for (const r of results) counts[r.class] = (counts[r.class] ?? 0) + 1;
  const baseOnly = results.filter((r) => r.class === "base_only");
  writeFileSync(
    `${base}.json`,
    JSON.stringify({ generated_at: new Date().toISOString(), counts, base_only_digest: digest, sites: results }, null, 2),
  );
  const line = (r) =>
    `| ${r.slug ?? r.tenant_id.slice(0, 8)} | ${r.tenant_kind ?? "?"} | ${r.repo ?? "-"} | ${r.service_id ?? "-"} | ${
      r.env_keys_present === null ? "?" : r.env_keys_present.length
    } | ${r.config_pill ? "yes" : ""} | ${(r.reasons.join("; ") || "").replace(/\|/g, "/").slice(0, 300)} |`;
  const section = (cls, title, note) => {
    const rows = results.filter((r) => r.class === cls);
    return [
      `## ${title} (${rows.length})`,
      note,
      "",
      "| tenant | kind | repo | render service | zavi keys on service | seed pill | why |",
      "|---|---|---|---|---|---|---|",
      ...rows.map(line),
      "",
    ].join("\n");
  };
  const md = [
    "# App Supabase cleanup scan",
    "",
    `Generated ${new Date().toISOString()}. Ready hosting rows scanned: ${results.length}.`,
    "",
    `Counts: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    "",
    section(
      "non_auth_supabase",
      "CROSS-TENANT FINDING: sites storing data in Zavi's Supabase",
      "These sites read or write through Zavi's control-plane Supabase with the anon key. Needs a reviewed migration to the site's own database. Never touched by --apply.",
    ),
    section(
      "auth",
      "Sites whose end users sign up into Zavi's Supabase auth",
      "Needs a reviewed refine to the own-DB login first; existing users re-register. Never touched by --apply.",
    ),
    section("unknown", "Could not classify", "Read errors, truncated trees, missing repo/service. Never touched by --apply."),
    section(
      "base_only",
      "Base-only: the keys are dead weight (--apply removes them)",
      `Only the untouched seed lib/supabase.ts references Supabase. "seed pill" = the seed home page shows "Database connected" and will show "Database not configured yet" after removal. Apply token: --yes-${baseOnly.length}-${digest}`,
    ),
  ].join("\n");
  writeFileSync(`${base}.md`, md);
  return { json: `${base}.json`, md: `${base}.md`, counts };
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const confirm = argv.find((a) => /^--yes-\d+-[0-9a-f]{8}$/.test(a));
  const outArg = argv.find((a) => a.startsWith("--out="));
  const outDir = outArg ? outArg.slice("--out=".length) : tmpdir();

  const ghToken = process.env.GITHUB_PROVISION_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!ghToken) {
    console.error("missing GITHUB_PROVISION_TOKEN (run from apps/backend with --env-file=.env)");
    return 2;
  }
  const renderKey = process.env.RENDER_API_KEY ?? null;
  if (apply && !renderKey) {
    console.error("--apply needs RENDER_API_KEY");
    return 2;
  }
  const { createScriptClient } = await import("./_supabase-script-client.mjs");
  const sb = createScriptClient();
  const seedShas = seedSupabaseShas();
  const ghc = ghClient(ghToken);

  const sites = await loadSites(sb);
  console.log(`ready hosting rows: ${sites.length}`);
  const results = [];
  for (const site of sites) {
    const r = await classifyOne(site, ghc, seedShas, renderKey);
    results.push(r);
    console.log(`  ${r.class.padEnd(18)} ${(r.slug ?? r.tenant_id.slice(0, 8)).padEnd(36)} ${r.repo ?? "-"}`);
  }
  const baseOnly = results.filter((r) => r.class === "base_only");
  const digest = setDigest(baseOnly.map((r) => r.service_id));
  const report = writeReport(outDir, results, digest);

  console.log("\ncounts:", JSON.stringify(report.counts));
  console.log(`GitHub rate limit remaining: ${ghc.remaining}`);
  console.log(`report: ${report.md}\n        ${report.json}`);

  if (!apply) {
    console.log(`\nDRY RUN: nothing changed. To remove the two keys from the ${baseOnly.length} base_only service(s):`);
    console.log(`  node --env-file=.env scripts/app-supabase-cleanup.mjs --apply --yes-${baseOnly.length}-${digest}`);
    return 0;
  }

  const [, n, d] = confirm ? confirm.match(/^--yes-(\d+)-([0-9a-f]{8})$/) : [];
  if (!confirm || Number(n) !== baseOnly.length || d !== digest) {
    console.error(
      `REFUSED: the base_only set right now is --yes-${baseOnly.length}-${digest}; you typed ${confirm ?? "nothing"}. Re-run the dry run and review the report.`,
    );
    return 1;
  }

  let changed = 0;
  for (const r of baseOnly) {
    const fresh = (await loadSites(sb)).find((s) => s.hosting_row_id === r.hosting_row_id);
    if (!fresh || fresh.service_id !== r.service_id || fresh.repo !== r.repo) {
      console.error(`STOP: ${r.slug} hosting/repo changed since the scan. ${changed} service(s) changed so far.`);
      return 1;
    }
    const again = await classifyOne(fresh, ghc, seedShas, renderKey);
    if (again.class !== "base_only") {
      console.error(`STOP: ${r.slug} re-classified as ${again.class} (${again.reasons.join("; ")}). ${changed} service(s) changed so far.`);
      return 1;
    }
    for (const key of ENV_KEYS) {
      const res = await fetch(`${RENDER}/services/${r.service_id}/env-vars/${key}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${renderKey}` },
      });
      if (![200, 204, 404].includes(res.status)) {
        console.error(`STOP: DELETE ${key} on ${r.service_id} -> HTTP ${res.status}. ${changed} service(s) changed so far.`);
        return 1;
      }
    }
    changed++;
    console.log(`  removed Zavi Supabase keys from ${r.service_id} (${r.slug})`);
  }
  console.log(`\ndone: ${changed} service(s) cleaned. Values stay in each current build until its next deploy.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`app-supabase-cleanup failed: ${e.message}`);
      process.exit(1);
    });
}
