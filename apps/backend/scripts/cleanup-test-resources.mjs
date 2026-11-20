
import { createClient } from "@supabase/supabase-js";

const PREFIXES = [
  "gt-",
  "gtb-",
  "gtv-",
  "qab-",
  "qabw-",
  "bp2-",
  "bp2r-",
  "bp3-",
  "b2-",
  "b2r-",
  "b3-",
];

const AUTH_EMAIL_PREFIXES = [
  "gtw",
  "qabw",
  "bp2-",
  "bp2r-",
  "bp3-",
  "gtv-",
  "gtb-",
];

const AGE_CUTOFF_MS = 24 * 60 * 60 * 1000;
const MAX_DELETES_PER_TYPE = 50;
const DRY_RUN = process.env.DRY_RUN === "1";

function matchesPrefix(name, prefixes) {
  if (!name) return false;
  const lower = String(name).toLowerCase();
  return prefixes.some((p) => lower.startsWith(p));
}

function matchesAuthEmail(email) {
  if (!email) return false;
  const lower = String(email).toLowerCase();
  if (!lower.endsWith("@thepraxis.ai")) return false;
  const local = lower.split("@")[0];
  return AUTH_EMAIL_PREFIXES.some((p) => local.startsWith(p));
}

function isOlderThan24h(isoOrMs) {
  if (!isoOrMs) return false;
  const t = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > AGE_CUTOFF_MS;
}

const THROWAWAY_TENANT_PREFIXES = [
  "bv3",
  "bv9",
  "bench-",
  "qa-",
  "test-",
  "smoke-",
  "gt-",
  "gtb-",
  "gtv-",
  "qab-",
  "qabw-",
  "bp2-",
  "bp3-",
  "b2-",
  "b2r-",
  "b3-",
  "cprobe",
  "credtest",
];

function isThrowawayTenantSlug(slug) {
  if (!slug || typeof slug !== "string") return false;
  const s = slug.toLowerCase();
  return THROWAWAY_TENANT_PREFIXES.some((p) => s.startsWith(p));
}

async function buildProtectedRepoSet() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "[guard] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required to compute the protected-repo set; refusing to delete blind",
    );
  }
  const sb = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: repoRows, error: rErr } = await sb
    .from("tenant_resources")
    .select("tenant_id, status, external_ref")
    .eq("resource_kind", "repo");
  if (rErr) throw new Error(`[guard] tenant_resources query failed: ${rErr.message}`);

  const { data: tenants, error: tErr } = await sb.from("tenants").select("id, slug");
  if (tErr) throw new Error(`[guard] tenants query failed: ${tErr.message}`);
  const liveSlugById = new Map((tenants ?? []).map((t) => [t.id, t.slug ?? null]));

  const protectedSet = new Set();
  for (const r of repoRows ?? []) {
    const full = r.external_ref?.github_full_name ?? r.external_ref?.full_name;
    if (!full || typeof full !== "string") continue;
    const status = (r.status ?? "").toLowerCase();
    if (status === "teardown" || status === "deprovisioning" || status === "torn_down") {
      continue;
    }
    const tenantAlive = r.tenant_id != null && liveSlugById.has(r.tenant_id);
    const tenantSlug = r.tenant_id != null ? liveSlugById.get(r.tenant_id) ?? null : null;
    const reapable =
      r.tenant_id == null || !tenantAlive || isThrowawayTenantSlug(tenantSlug);
    if (!reapable) protectedSet.add(full);
  }
  console.log(`[guard] protected live-customer repos: ${protectedSet.size}`);
  return protectedSet;
}

async function cleanupGitHubRepos(protectedRepos) {
  const token = process.env.GITHUB_PROVISION_TOKEN;
  const org = process.env.PRAXIS_GITHUB_ORG ?? "praxis-built";
  if (!token) {
    console.warn("[gh] GITHUB_PROVISION_TOKEN not set — skipping GitHub cleanup");
    return { deleted: 0, errors: 0 };
  }
  if (!(protectedRepos instanceof Set)) {
    throw new Error("[gh] protected-repo set missing — refusing to delete blind");
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const candidates = [];
  for (let page = 1; page <= 10; page++) {
    const url = `https://api.github.com/orgs/${org}/repos?per_page=100&sort=created&direction=asc&page=${page}`;
    const r = await fetch(url, { headers });
    if (r.status !== 200) {
      console.warn(`[gh] list repos page ${page} failed (${r.status}): ${await r.text()}`);
      break;
    }
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const repo of arr) {
      if (matchesPrefix(repo.name, PREFIXES) && isOlderThan24h(repo.created_at)) {
        if (protectedRepos.has(repo.full_name)) {
          console.log(`[gh] SKIP protected live-customer repo ${repo.full_name}`);
          continue;
        }
        candidates.push({
          full_name: repo.full_name,
          name: repo.name,
          created_at: repo.created_at,
        });
      }
    }
    if (arr.length < 100) break;
  }

  console.log(`[gh] candidates: ${candidates.length} (capping at ${MAX_DELETES_PER_TYPE})`);
  const toDelete = candidates.slice(0, MAX_DELETES_PER_TYPE);
  for (const c of toDelete) {
    console.log(`[gh] ${DRY_RUN ? "DRY_RUN would delete" : "deleting"} ${c.full_name} (created ${c.created_at})`);
  }

  if (DRY_RUN) return { deleted: 0, errors: 0, candidates: candidates.length };

  let deleted = 0;
  let errors = 0;
  for (const c of toDelete) {
    try {
      const r = await fetch(`https://api.github.com/repos/${c.full_name}`, { method: "DELETE", headers });
      if (r.status === 204 || r.status === 404) {
        deleted++;
      } else {
        errors++;
        console.warn(`[gh] delete ${c.full_name} failed (${r.status}): ${await r.text()}`);
      }
    } catch (e) {
      errors++;
      console.warn(`[gh] delete ${c.full_name} threw: ${e?.message ?? e}`);
    }
  }
  return { deleted, errors, candidates: candidates.length };
}

async function cleanupRenderServices() {
  const token = process.env.RENDER_API_KEY;
  const owner = process.env.RENDER_OWNER_ID;
  if (!token) {
    console.warn("[render] RENDER_API_KEY not set — skipping Render cleanup");
    return { deleted: 0, errors: 0 };
  }
  if (!owner) {
    console.warn("[render] RENDER_OWNER_ID not set — skipping Render cleanup");
    return { deleted: 0, errors: 0 };
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const candidates = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const cursorQ = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const url = `https://api.render.com/v1/services?ownerId=${owner}&limit=100${cursorQ}`;
    const r = await fetch(url, { headers });
    if (r.status !== 200) {
      console.warn(`[render] list services page ${page} failed (${r.status}): ${await r.text()}`);
      break;
    }
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const item of arr) {
      const svc = item?.service ?? item;
      const name = svc?.name;
      const createdAt = svc?.createdAt ?? svc?.created_at;
      if (matchesPrefix(name, PREFIXES) && isOlderThan24h(createdAt)) {
        candidates.push({
          id: svc?.id,
          name,
          created_at: createdAt,
        });
      }
    }
    const last = arr[arr.length - 1];
    cursor = last?.cursor ?? null;
    if (!cursor || arr.length < 100) break;
  }

  console.log(`[render] candidates: ${candidates.length} (capping at ${MAX_DELETES_PER_TYPE})`);
  const toDelete = candidates.slice(0, MAX_DELETES_PER_TYPE);
  for (const c of toDelete) {
    console.log(`[render] ${DRY_RUN ? "DRY_RUN would delete" : "deleting"} ${c.name} (${c.id}, created ${c.created_at})`);
  }

  if (DRY_RUN) return { deleted: 0, errors: 0, candidates: candidates.length };

  let deleted = 0;
  let errors = 0;
  for (const c of toDelete) {
    if (!c.id) continue;
    try {
      const r = await fetch(`https://api.render.com/v1/services/${c.id}`, { method: "DELETE", headers });
      if (r.status === 200 || r.status === 204 || r.status === 404) {
        deleted++;
      } else {
        errors++;
        console.warn(`[render] delete ${c.name} failed (${r.status}): ${await r.text()}`);
      }
    } catch (e) {
      errors++;
      console.warn(`[render] delete ${c.name} threw: ${e?.message ?? e}`);
    }
  }
  return { deleted, errors, candidates: candidates.length };
}

async function cleanupNeonProjects() {
  const token = process.env.NEON_API_KEY;
  const org = process.env.NEON_ORG_ID;
  if (!token) {
    console.warn("[neon] NEON_API_KEY not set — skipping Neon cleanup");
    return { deleted: 0, errors: 0 };
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const candidates = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams();
    params.set("limit", "100");
    if (org) params.set("org_id", org);
    if (cursor) params.set("cursor", cursor);
    const url = `https://console.neon.tech/api/v2/projects?${params.toString()}`;
    const r = await fetch(url, { headers });
    if (r.status !== 200) {
      console.warn(`[neon] list projects page ${page} failed (${r.status}): ${await r.text()}`);
      break;
    }
    const body = await r.json();
    const arr = body?.projects ?? [];
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const proj of arr) {
      const name = proj?.name;
      const createdAt = proj?.created_at;
      if (matchesPrefix(name, PREFIXES) && isOlderThan24h(createdAt)) {
        candidates.push({
          id: proj?.id,
          name,
          created_at: createdAt,
        });
      }
    }
    cursor = body?.pagination?.cursor ?? null;
    if (!cursor) break;
  }

  console.log(`[neon] candidates: ${candidates.length} (capping at ${MAX_DELETES_PER_TYPE})`);
  const toDelete = candidates.slice(0, MAX_DELETES_PER_TYPE);
  for (const c of toDelete) {
    console.log(`[neon] ${DRY_RUN ? "DRY_RUN would delete" : "deleting"} ${c.name} (${c.id}, created ${c.created_at})`);
  }

  if (DRY_RUN) return { deleted: 0, errors: 0, candidates: candidates.length };

  let deleted = 0;
  let errors = 0;
  for (const c of toDelete) {
    if (!c.id) continue;
    try {
      const r = await fetch(`https://console.neon.tech/api/v2/projects/${c.id}`, { method: "DELETE", headers });
      if (r.status === 200 || r.status === 204 || r.status === 404) {
        deleted++;
      } else {
        errors++;
        console.warn(`[neon] delete ${c.name} failed (${r.status}): ${await r.text()}`);
      }
    } catch (e) {
      errors++;
      console.warn(`[neon] delete ${c.name} threw: ${e?.message ?? e}`);
    }
  }
  return { deleted, errors, candidates: candidates.length };
}

async function cleanupSupabaseAuthUsers() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.warn("[auth] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — skipping auth cleanup");
    return { deleted: 0, errors: 0, tenantsSkipped: 0 };
  }
  const sb = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const candidates = [];
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      console.warn(`[auth] listUsers page ${page} failed: ${error.message}`);
      break;
    }
    const users = data?.users ?? [];
    if (users.length === 0) break;
    for (const u of users) {
      if (matchesAuthEmail(u.email) && isOlderThan24h(u.created_at)) {
        candidates.push({ id: u.id, email: u.email, created_at: u.created_at });
      }
    }
    if (users.length < 200) break;
  }

  console.log(`[auth] candidates: ${candidates.length} (capping at ${MAX_DELETES_PER_TYPE})`);
  const toDelete = candidates.slice(0, MAX_DELETES_PER_TYPE);
  for (const c of toDelete) {
    console.log(`[auth] ${DRY_RUN ? "DRY_RUN would delete" : "deleting"} ${c.email} (${c.id}, created ${c.created_at})`);
  }

  let deleted = 0;
  let errors = 0;
  if (!DRY_RUN) {
    for (const c of toDelete) {
      try {
        const { error } = await sb.auth.admin.deleteUser(c.id);
        if (error) {
          errors++;
          console.warn(`[auth] delete ${c.email} failed: ${error.message}`);
        } else {
          deleted++;
        }
      } catch (e) {
        errors++;
        console.warn(`[auth] delete ${c.email} threw: ${e?.message ?? e}`);
      }
    }
  }

  let tenantsSkipped = 0;
  try {
    const { data: tenants, error } = await sb
      .from("tenants")
      .select("id, slug, display_name, created_at")
      .limit(2000);
    if (error) {
      console.warn(`[tenants] list failed: ${error.message}`);
    } else {
      for (const t of tenants ?? []) {
        if (
          (matchesPrefix(t.slug, PREFIXES) || matchesPrefix(t.display_name, PREFIXES)) &&
          isOlderThan24h(t.created_at)
        ) {
          tenantsSkipped++;
          console.log(
            `[tenants] SKIP (WORM ledger blocks delete): id=${t.id} slug=${t.slug} display_name=${t.display_name} created=${t.created_at}`,
          );
        }
      }
    }
  } catch (e) {
    console.warn(`[tenants] scan threw: ${e?.message ?? e}`);
  }

  return { deleted, errors, candidates: candidates.length, tenantsSkipped };
}

export async function runCleanup(opts = {}) {
  const dryRun = opts.dryRun ?? DRY_RUN;
  const restoreDryRun = process.env.DRY_RUN;
  if (dryRun) process.env.DRY_RUN = "1";

  console.log(
    `cleanup-test-resources start dryRun=${dryRun} prefixes=${PREFIXES.join(",")} age=>24h cap=${MAX_DELETES_PER_TYPE}`,
  );

  const protectedRepos = await buildProtectedRepoSet();

  const gh = await cleanupGitHubRepos(protectedRepos);
  const render = await cleanupRenderServices();
  const neon = await cleanupNeonProjects();
  const auth = await cleanupSupabaseAuthUsers();

  const summary = `cleanup: GH=${gh.deleted} Render=${render.deleted} Neon=${neon.deleted} auth=${auth.deleted} tenants-skipped=${auth.tenantsSkipped}`;
  console.log(summary);
  if (dryRun) {
    console.log(
      `(DRY_RUN — no deletes performed; candidate counts: GH=${gh.candidates ?? 0} Render=${render.candidates ?? 0} Neon=${neon.candidates ?? 0} auth=${auth.candidates ?? 0})`,
    );
  }
  console.log(`errors: GH=${gh.errors} Render=${render.errors} Neon=${neon.errors} auth=${auth.errors}`);

  process.env.DRY_RUN = restoreDryRun ?? "";

  return {
    dryRun,
    gh,
    render,
    neon,
    auth,
    summary,
  };
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  runCleanup().then(
    () => process.exit(0),
    (e) => {
      console.error("cleanup-test-resources fatal:", e);
      process.exit(1);
    },
  );
}
