
import { createClient } from "@supabase/supabase-js";

const GH = "https://api.github.com";
const RUNTIME_SRC = "https://www.zaviagent.com/zavi-editor-runtime.js";
const SNIPPET = [
  "        {/* zavi:editor — inline visual editor, loaded from Zavi's origin so it",
  "            reaches this app with no rebuild. Inert unless framed by an allowlisted",
  "            Zavi origin; harmless to a real visitor. Safe to delete. (backfill) */}",
  `        <script src="${RUNTIME_SRC}" defer />`,
].join("\n");
const LAYOUT_PATHS = ["app/layout.tsx", "src/app/layout.tsx", "app/layout.jsx", "src/app/layout.jsx"];

const APPLY = process.argv.includes("--apply");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : null;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN = process.env.GITHUB_PROVISION_TOKEN;

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}
if (!SUPABASE_URL || !SERVICE_KEY) die("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (run with --env-file=.env)");
if (!TOKEN) die("GITHUB_PROVISION_TOKEN missing (run with --env-file=.env)");

const ghHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
};

async function getFile(fullName, path) {
  const res = await fetch(`${GH}/repos/${fullName}/contents/${path}`, { headers: ghHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path} (${res.status}): ${await res.text()}`);
  const j = await res.json();
  return { text: Buffer.from(j.content, "base64").toString("utf8"), sha: j.sha };
}

function inject(source) {
  const idx = source.lastIndexOf("</body>");
  if (idx === -1) return null;
  return source.slice(0, idx) + SNIPPET + "\n      " + source.slice(idx);
}

async function putFile(fullName, path, newText, sha) {
  const res = await fetch(`${GH}/repos/${fullName}/contents/${path}`, {
    method: "PUT",
    headers: ghHeaders,
    body: JSON.stringify({
      message: "chore(zavi): enable inline website editor (add editor runtime)",
      content: Buffer.from(newText, "utf8").toString("base64"),
      sha,
    }),
  });
  if (!res.ok) throw new Error(`PUT ${path} (${res.status}): ${await res.text()}`);
  return res.json();
}

async function main() {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data, error } = await sb
    .from("tenant_resources")
    .select("tenant_id, mode, external_ref")
    .eq("resource_kind", "repo")
    .eq("mode", "provisioned");
  if (error) die(`tenant_resources read failed: ${error.message}`);

  let repos = (data ?? [])
    .map((r) => ({ tenant_id: r.tenant_id, full: r.external_ref?.github_full_name }))
    .filter((r) => typeof r.full === "string");
  if (ONLY) repos = repos.filter((r) => r.full === ONLY);

  console.log(`${APPLY ? "APPLY" : "DRY-RUN"} — ${repos.length} provisioned repo(s)${ONLY ? ` (filtered to ${ONLY})` : ""}\n`);

  const tally = { updated: 0, already: 0, no_layout: 0, failed: 0 };
  for (const { full, tenant_id } of repos) {
    try {
      let file = null;
      let path = null;
      for (const p of LAYOUT_PATHS) {
        file = await getFile(full, p);
        if (file) {
          path = p;
          break;
        }
      }
      if (!file) {
        console.log(`  no-layout  ${full}  (no app/layout.tsx found)`);
        tally.no_layout++;
        continue;
      }
      if (file.text.includes("zavi-editor-runtime.js")) {
        console.log(`  already    ${full}  (${path} already has the runtime)`);
        tally.already++;
        continue;
      }
      const next = inject(file.text);
      if (!next) {
        console.log(`  no-layout  ${full}  (${path} has no </body> to anchor to)`);
        tally.no_layout++;
        continue;
      }
      if (!APPLY) {
        console.log(`  would-fix  ${full}  (${path}) [tenant ${tenant_id}]`);
        tally.updated++;
        continue;
      }
      await putFile(full, path, next, file.sha);
      console.log(`  UPDATED    ${full}  (${path}) → Render will redeploy`);
      tally.updated++;
    } catch (e) {
      console.log(`  FAILED     ${full}  ${e.message}`);
      tally.failed++;
    }
  }

  console.log(
    `\nDone. ${APPLY ? "updated" : "would-update"}=${tally.updated}  already=${tally.already}  no-layout=${tally.no_layout}  failed=${tally.failed}`,
  );
  if (!APPLY && tally.updated > 0) {
    console.log("Re-run with --apply (Ravi-authorized) to commit + redeploy.");
  }
}

main().catch((e) => die(e.stack || e.message));
