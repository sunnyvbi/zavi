
import { createHash } from "node:crypto";
import { createScriptClient } from "./_supabase-script-client.mjs";

const NEON = "https://console.neon.tech/api/v2";
const HARD_KEEP_SLUGS = ["upcar-ai", "upcar-private", "apna-tutor-dogfood"];
const HUMAN_TRIGGERS = [
  "chat", "slack", "whatsapp", "teams", "manual", "discord", "telegram", "email",
  "playbook", "mcp",
  "channel_recipe", "handoff",
];
const ALL_BUCKETS = ["orphan", "superseded", "test-inert", "test-active", "real"];
const DEFAULT_BUCKETS = ["orphan", "test-inert"];

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const paint = (c, s) => `${C[c] || ""}${s}${C.reset}`;
const BUCKET_COLOR = { orphan: "cyan", "test-inert": "yellow", "test-active": "gray", real: "green" };

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const confirmArg = argv.find((a) => /^--yes-delete-\d+-[0-9a-f]{8}$/.test(a));
const confirmParts = confirmArg
  ? confirmArg.slice("--yes-delete-".length).split("-")
  : null;
const confirmCount = confirmParts ? Number(confirmParts[0]) : null;
const confirmDigest = confirmParts ? confirmParts[1] : null;

function setDigest(ids) {
  return createHash("sha256").update([...ids].sort().join(",")).digest("hex").slice(0, 8);
}
const csv = (flag, fallback) => {
  const a = argv.find((x) => x.startsWith(`${flag}=`));
  if (!a) return fallback;
  return a.slice(flag.length + 1).split(",").map((s) => s.trim()).filter(Boolean);
};
const buckets = csv("--buckets", DEFAULT_BUCKETS);
const keep = new Set(csv("--keep", []));

const bad = buckets.filter((b) => !ALL_BUCKETS.includes(b));
if (bad.length) {
  console.error(paint("red", `unknown bucket(s): ${bad.join(", ")}. Valid: ${ALL_BUCKETS.join(", ")}`));
  process.exit(2);
}

const sb = createScriptClient();
const token = process.env.NEON_API_KEY;
if (!token) {
  console.error(paint("red", "NEON_API_KEY is required. Run from apps/backend with: node --env-file=.env scripts/reclaim-neon-build-projects.mjs"));
  process.exit(2);
}
const neonHeaders = { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" };

async function listNeonProjects() {
  const org = process.env.NEON_ORG_ID;
  const out = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ limit: "100" });
    if (org) params.set("org_id", org);
    if (cursor) params.set("cursor", cursor);
    const r = await fetch(`${NEON}/projects?${params}`, { headers: neonHeaders });
    if (r.status !== 200) throw new Error(`neon list projects page ${page} failed (${r.status}): ${await r.text()}`);
    const body = await r.json();
    const arr = body?.projects ?? [];
    if (!Array.isArray(arr) || arr.length === 0) break;
    out.push(...arr);
    cursor = body?.pagination?.cursor ?? null;
    if (!cursor) break;
  }
  return out;
}

async function verifySafeToDelete(sb, r, tenantById) {
  const { data, error } = await sb
    .from("tenant_resources")
    .select("id,tenant_id,status")
    .eq("resource_kind", "db")
    .eq("external_ref->>neon_project_id", r.id);
  if (error) return `could not re-verify: ${error.message}`;
  const live = (data || []).filter((c) => c.status !== "torn_down" && c.status !== "teardown");

  if (r.bucket === "orphan" || r.bucket === "superseded") {
    return live.length
      ? `bucketed '${r.bucket}' (no owner) but a direct query finds ${live.length} live claim(s): ${live.map((c) => c.tenant_id.slice(0, 8)).join(", ")}`
      : null;
  }

  if (r.bucket === "real" || r.bucket === "test-active") {
    const knownIds = new Set((r.claims || []).map((c) => c.id));
    for (const c of live) {
      const t = tenantById.get(c.tenant_id);
      if (!t) return `claim ${c.id} belongs to tenant ${c.tenant_id.slice(0, 8)} which could not be resolved`;
      if (!knownIds.has(c.id)) return `a NEW claim (${c.id}, tenant ${t.slug}) appeared since the manifest was built`;
      if (HARD_KEEP_SLUGS.includes(t.slug)) return `claim ${c.id} belongs to protected tenant ${t.slug}`;
    }
    return null;
  }

  const knownIds = new Set((r.claims || []).map((c) => c.id));
  for (const c of live) {
    const t = tenantById.get(c.tenant_id);
    if (!t) return `claim ${c.id} belongs to tenant ${c.tenant_id.slice(0, 8)} which could not be resolved`;
    if (t.kind !== "test") return `claim ${c.id} now belongs to a '${t.kind}' tenant (${t.slug}), not a test tenant`;
    if (!knownIds.has(c.id)) return `a NEW claim (${c.id}, tenant ${t.slug}) appeared since the manifest was built`;
  }
  return null;
}

async function suspendClaimantServices(r) {
  const suspended = [];
  const tenantIds = [...new Set((r.claims || []).map((c) => c.tenant_id))];
  if (!tenantIds.length) return { error: null, suspended };
  const rk = process.env.RENDER_API_KEY;
  if (!rk) return { error: "RENDER_API_KEY not set, cannot suspend the app that uses this database", suspended };
  const { data, error } = await sb
    .from("tenant_resources")
    .select("external_ref")
    .eq("resource_kind", "hosting")
    .eq("provider", "render")
    .in("tenant_id", tenantIds);
  if (error) return { error: `hosting lookup failed: ${error.message}`, suspended };
  const h = { Authorization: `Bearer ${rk}`, Accept: "application/json" };
  try {
    for (const row of data || []) {
      const sid = row.external_ref?.render_service_id;
      if (!sid) continue;
      const get = await fetch(`https://api.render.com/v1/services/${sid}`, { headers: h });
      if (get.status === 404) continue;
      if (get.status !== 200) return { error: `render lookup ${sid} failed (${get.status})`, suspended };
      if ((await get.json()).suspended === "suspended") continue;
      const res = await fetch(`https://api.render.com/v1/services/${sid}/suspend`, { method: "POST", headers: h });
      if (![200, 202, 204].includes(res.status)) return { error: `render suspend ${sid} failed (${res.status})`, suspended };
      suspended.push(sid);
      console.log(paint("green", `  suspended render service ${sid}`));
    }
  } catch (e) {
    return { error: `render call threw: ${e.message}`, suspended };
  }
  return { error: null, suspended };
}

async function resumeServices(ids) {
  for (const sid of ids) {
    let status = "threw";
    try {
      const res = await fetch(`https://api.render.com/v1/services/${sid}/resume`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}` },
      });
      status = res.status;
    } catch {}
    console.error(
      [200, 202, 204].includes(status)
        ? paint("red", `  resumed ${sid} after the failed delete`)
        : paint("red", `  ⚠⚠ could NOT resume ${sid} (${status}); its database is intact, resume it by hand`),
    );
  }
}

async function main() {
  const projects = await listNeonProjects();

  const resources = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error: resErr } = await sb
      .from("tenant_resources")
      .select("id,tenant_id,status,external_ref")
      .eq("resource_kind", "db")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (resErr) throw new Error(`tenant_resources read failed: ${resErr.message}`);
    const page = data || [];
    resources.push(...page);
    if (page.length < PAGE) break;
  }
  const rowsByProject = new Map();
  for (const row of resources || []) {
    const pid = row.external_ref?.neon_project_id;
    if (!pid) continue;
    if (!rowsByProject.has(pid)) rowsByProject.set(pid, []);
    rowsByProject.get(pid).push(row);
  }

  const tenantIds = [...new Set((resources || []).map((r) => r.tenant_id).filter(Boolean))];
  const tenantById = new Map();
  for (let i = 0; i < tenantIds.length; i += 500) {
    const { data: tenants, error: tenErr } = await sb
      .from("tenants")
      .select("id,slug,kind")
      .in("id", tenantIds.slice(i, i + 500));
    if (tenErr) throw new Error(`tenants read failed: ${tenErr.message}`);
    for (const t of tenants || []) tenantById.set(t.id, t);
  }

  const humanRuns = new Map();
  for (const tid of tenantIds) {
    const { count, error } = await sb
      .from("agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tid)
      .in("trigger", HUMAN_TRIGGERS);
    if (error) throw new Error(`agent_runs count failed for ${tid}: ${error.message}`);
    humanRuns.set(tid, count ?? 0);
  }

  const claimedNames = new Set(
    projects.filter((p) => (rowsByProject.get(p.id) || []).length).map((p) => p.name),
  );

  const rows = projects.map((p) => {
    const claims = rowsByProject.get(p.id) || [];
    const claimTenants = claims.map((c) => tenantById.get(c.tenant_id)).filter(Boolean);
    const tenant = claimTenants[0] ?? null;
    const runs = Math.max(0, ...claimTenants.map((t) => humanRuns.get(t.id) ?? 0), 0);
    const anyReal = claimTenants.some((t) => t.kind !== "test");
    const unresolved = claims.length > claimTenants.length;
    const supersededDupe = !claims.length && claimedNames.has(p.name);
    const bucket = supersededDupe
      ? "superseded"
      : !claims.length
      ? "orphan"
      : unresolved || anyReal
        ? "real"
        : runs > 0
          ? "test-active"
          : "test-inert";
    return {
      name: p.name,
      id: p.id,
      mb: Math.round((p.synthetic_storage_size ?? 0) / 1048576),
      slug: tenant?.slug ?? "—",
      kind: unresolved ? "(tenant missing)" : (tenant?.kind ?? (claims.length ? "(tenant missing)" : "—")),
      allSlugs: claimTenants.map((t) => t.slug).filter(Boolean),
      humanRuns: claims.length ? runs : 0,
      bucket,
      claims,
    };
  });

  const hardSkipped = [];
  const keepSkipped = [];
  const selected = [];
  for (const r of rows) {
    if (!buckets.includes(r.bucket)) continue;
    if ([r.slug, ...(r.allSlugs || [])].some((sl) => HARD_KEEP_SLUGS.includes(sl))) {
      hardSkipped.push(r);
      continue;
    }
    if (
      keep.has(r.id) ||
      keep.has(r.name) ||
      [r.slug, ...(r.allSlugs || [])].some((sl) => keep.has(sl))
    ) {
      keepSkipped.push(r);
      continue;
    }
    selected.push(r);
  }

  console.log(paint("bold", `\n━━ NEON BUILD PROJECTS (${rows.length} of a 100-project FREE plan cap) ━━`));
  console.log(
    paint("dim", `  ${"project name".padEnd(40)} ${"project id".padEnd(22)} ${"MB".padStart(6)}  ${"tenant slug".padEnd(34)} ${"kind".padEnd(15)} ${"human".padStart(5)}  bucket`),
  );
  const order = { orphan: 0, "test-inert": 1, "test-active": 2, real: 3 };
  for (const r of [...rows].sort((a, b) => (order[a.bucket] - order[b.bucket]) || a.name.localeCompare(b.name))) {
    const mark = selected.includes(r) ? paint("red", "DEL") : "   ";
    console.log(
      `  ${mark} ${r.name.slice(0, 40).padEnd(40)} ${r.id.padEnd(22)} ${String(r.mb).padStart(6)}  ${r.slug.slice(0, 34).padEnd(34)} ${r.kind.padEnd(15)} ${String(r.humanRuns).padStart(5)}  ${paint(BUCKET_COLOR[r.bucket], r.bucket)}`,
    );
  }

  console.log(paint("bold", "\n  totals by bucket:"));
  for (const b of ALL_BUCKETS) {
    const inB = rows.filter((r) => r.bucket === b);
    const mb = inB.reduce((s, r) => s + r.mb, 0);
    console.log(`    ${paint(BUCKET_COLOR[b], b.padEnd(12))} ${String(inB.length).padStart(3)} projects  ${String(mb).padStart(6)} MB${buckets.includes(b) ? paint("dim", "   (in scope)") : ""}`);
  }

  for (const r of hardSkipped) {
    console.log(paint("green", `  SKIPPED (hard exclusion, no flag overrides): ${r.name} — tenant ${r.slug}`));
  }
  for (const r of keepSkipped) {
    console.log(paint("green", `  SKIPPED (--keep): ${r.name} — tenant ${r.slug}`));
  }

  console.log(
    `\n  scope=${buckets.join(",")}  ${paint("bold", `${selected.length} project(s) would be deleted`)}` +
      ` (${selected.reduce((s, r) => s + r.mb, 0)} MB), leaving ${rows.length - selected.length} of 100.`,
  );

  if (!apply) {
    let mismatches = 0;
    for (const r of selected) {
      const reason = await verifySafeToDelete(sb, r, tenantById);
      if (reason) {
        console.error(paint("red", `  ⚠ DISAGREE: ${r.name} (${r.id}) — ${reason}`));
        mismatches++;
      }
    }
    if (mismatches) {
      console.error(
        paint("red", `\n  REFUSING to print an apply command: ${mismatches} of ${selected.length} selected project(s) failed the same check the delete path runs.`) +
          paint("red", "\n  The manifest and the database disagree about ownership. Investigate before deleting anything.\n"),
      );
      return 1;
    }
    console.log(paint("green", `\n  safety gate self-check: all ${selected.length} selected project(s) re-verified against the database: ownership unchanged since the manifest (same check the delete path runs).`));
    console.log(paint("yellow", "\n  DRY RUN — nothing was deleted. To actually delete the set above, run:"));
    console.log(
      paint("bold", `    node --env-file=.env scripts/reclaim-neon-build-projects.mjs --apply --yes-delete-${selected.length}-${setDigest(selected.map((r) => r.id))}` +
        (buckets.join(",") === DEFAULT_BUCKETS.join(",") ? "" : ` --buckets=${buckets.join(",")}`)),
    );
    console.log(paint("dim", "  Re-run the dry run first if anything has changed — the token pins this exact set.\n"));
    return 0;
  }

  const digest = setDigest(selected.map((r) => r.id));
  if (confirmCount === null) {
    console.error(
      paint("red", `\n  REFUSED: --apply requires the typed confirmation --yes-delete-${selected.length}-${digest}.`),
    );
    return 1;
  }
  if (confirmCount !== selected.length || confirmDigest !== digest) {
    console.error(
      paint("red", `\n  REFUSED: you typed --yes-delete-${confirmCount}-${confirmDigest}, but the set in scope right now is ${selected.length} project(s) / ${digest}.`) +
        "\n  The set changed since that command was written — same size is NOT the same databases." +
        "\n  Re-run the dry run, review the manifest, and retype the token it prints.",
    );
    return 1;
  }
  if (!selected.length) {
    console.log(paint("green", "\n  Nothing in scope. Done.\n"));
    return 0;
  }

  console.log(paint("bold", `\n━━ DELETING ${selected.length} project(s) ━━`));
  let deleted = 0;
  let rowUpdateFailures = 0;
  for (const r of selected) {
    const reason = await verifySafeToDelete(sb, r, tenantById);
    if (reason) {
      console.error(paint("red", `  SKIPPED ${r.name} (${r.id}): ${reason}`));
      console.error(
        paint("red", `  The manifest said this was safe and the database disagrees. STOPPING. ${deleted} deleted; this project untouched.`),
      );
      return 1;
    }

    const sus = await suspendClaimantServices(r);
    if (sus.error) {
      await resumeServices(sus.suspended);
      console.error(paint("red", `  FAILED ${r.name} (${r.id}): ${sus.error}`));
      console.error(paint("red", `  STOPPING. ${deleted} deleted; this project untouched.`));
      return 1;
    }

    let resp;
    try {
      resp = await fetch(`${NEON}/projects/${r.id}`, { method: "DELETE", headers: neonHeaders });
    } catch (e) {
      await resumeServices(sus.suspended);
      throw e;
    }
    if (resp.status !== 200 && resp.status !== 204 && resp.status !== 404) {
      await resumeServices(sus.suspended);
      console.error(paint("red", `  FAILED ${r.name} (${r.id}): HTTP ${resp.status} ${await resp.text()}`));
      console.error(paint("red", `  STOPPING. ${deleted} deleted, ${selected.length - deleted - 1} untouched.`));
      return 1;
    }
    deleted++;
    console.log(paint("green", `  deleted ${r.name} (${r.id}, ${r.mb} MB, tenant ${r.slug})`));

    for (const row of r.claims) {
      const { error } = await sb
        .from("tenant_resources")
        .update({ status: "torn_down", updated_at: new Date().toISOString() })
        .eq("id", row.id);
      if (error) {
        rowUpdateFailures++;
        console.error(
          paint("red", `  ⚠⚠ WARNING: Neon project ${r.id} is DELETED but tenant_resources row ${row.id} (tenant ${row.tenant_id}, slug ${r.slug}) could NOT be marked torn_down: ${error.message}`) +
            paint("red", `\n  ⚠⚠ That tenant's app still believes it has a database. Fix that row by hand.`),
        );
        console.error(
          paint("red", `  STOPPING. ${deleted} deleted, ${selected.length - deleted} untouched.`),
        );
        return 1;
      }
    }
    await new Promise((res) => setTimeout(res, 400));
  }

  console.log(paint("bold", `\n  done: ${deleted} deleted, ${rowUpdateFailures} row update failure(s).\n`));
  return rowUpdateFailures ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(paint("red", `reclaim-neon-build-projects failed: ${e.message}`));
    process.exit(1);
  });
