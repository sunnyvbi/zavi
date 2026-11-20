#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DIR = "supabase/migrations/";

function base(p) {
  return p.slice(p.lastIndexOf("/") + 1);
}

function versionOf(name) {
  const m = /^(\d+)_.*\.sql$/.exec(base(name));
  return m ? m[1] : null;
}

function isMigration(p) {
  return p.startsWith(DIR) && !p.slice(DIR.length).includes("/") && versionOf(p) !== null;
}

function nextFree(v, taken) {
  let n = BigInt(v) + 1n;
  for (;;) {
    const s = n.toString().padStart(v.length, "0");
    if (!taken.has(s)) return s;
    n += 1n;
  }
}

export function findConflicts(added, main) {
  const addedM = [...new Set(added.filter(isMigration).map(base))].sort();
  const addedSet = new Set(addedM);
  const mainM = [...new Set(main.filter(isMigration).map(base))].filter((f) => !addedSet.has(f));
  const byVersion = new Map();
  for (const f of mainM) byVersion.set(versionOf(f), f);
  const taken = new Set([...mainM, ...addedM].map(versionOf));

  const out = [];
  const seenInPr = new Map();
  for (const f of addedM) {
    const v = versionOf(f);
    const clash = byVersion.get(v) ?? seenInPr.get(v);
    if (clash) {
      const suggest = nextFree(v, taken);
      taken.add(suggest);
      out.push({ added: f, existing: clash, version: v, suggest });
    } else {
      seenInPr.set(v, f);
    }
  }
  return out;
}

export function formatConflicts(conflicts) {
  const lines = [
    `Migration version collision: ${conflicts.length} new migration(s) reuse a version already on main.`,
    "Two files with one version break `supabase db push` (schema_migrations_pkey) and fail every PR once both are on main.",
    "",
  ];
  for (const c of conflicts) {
    lines.push(
      `- version ${c.version}: this PR adds ${DIR}${c.added}, main already has ${DIR}${c.existing}. ` +
        `Rename yours, e.g. to ${DIR}${c.suggest}${c.added.slice(c.version.length)}`,
    );
  }
  return lines.join("\n");
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function lines(s) {
  return s.split("\n").map((l) => l.trim()).filter(Boolean);
}

function revParse(ref) {
  return git(["rev-parse", "--verify", `${ref}^{commit}`]).trim();
}

function fetchMainInto(ref) {
  git(["fetch", "--quiet", "--no-tags", "--depth=1", "origin", `+refs/heads/main:refs/remotes/${ref}`]);
}

function mainFiles(ref) {
  return lines(git(["ls-tree", "--name-only", ref, DIR]));
}

function selfTest() {
  let fail = 0;
  const eq = (name, got, want) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g !== w) {
      fail++;
      console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`);
    } else console.log(`ok   ${name}`);
  };
  const M = (f) => DIR + f;
  const main = [M("0001_init.sql"), M("20260929120000_a.sql"), M("20260929120001_b.sql"), "README.md"];

  eq("unique version passes", findConflicts([M("20260930000000_new.sql")], main), []);
  eq("same version as main fails, suggests next free (skips taken)",
    findConflicts([M("20260929120000_mine.sql")], main),
    [{ added: "20260929120000_mine.sql", existing: "20260929120000_a.sql", version: "20260929120000", suggest: "20260929120002" }]);
  eq("identical file name already on main is not a collision",
    findConflicts([M("20260929120000_a.sql")], main), []);
  eq("PR that deletes main's file and re-adds its version under a new name FAILS",
    findConflicts([M("20260929120000_renamed.sql")], main),
    [{ added: "20260929120000_renamed.sql", existing: "20260929120000_a.sql", version: "20260929120000", suggest: "20260929120002" }]);
  eq("collision fix that renames the later file to a new version passes",
    findConflicts([M("20260929120050_a2.sql")], [...main, M("20260929120000_a2.sql")]), []);
  eq("two new files in one PR with one version fail",
    findConflicts([M("20260930000000_x.sql"), M("20260930000000_y.sql")], main),
    [{ added: "20260930000000_y.sql", existing: "20260930000000_x.sql", version: "20260930000000", suggest: "20260930000001" }]);
  eq("non-migration paths ignored",
    findConflicts(["apps/x/20260929120000_a.sql", M("sub/20260929120000_z.sql"), M("notes.md")], main), []);
  eq("legacy 4-digit width preserved in suggestion",
    findConflicts([M("0001_again.sql")], main)[0]?.suggest, "0002");
  const sha = "abcdef0123456789";
  eq("PR with no migrations still gets a success status",
    statusFor(findConflicts(["apps/web/x.ts"], main), 0, sha),
    { state: "success", description: "no new migrations (main@abcdef012)" });
  eq("PR with a clean migration gets success naming main",
    statusFor([], 1, sha), { state: "success", description: "no new migration reuses a version on main@abcdef012" });
  eq("clash gets failure naming the version and main",
    statusFor(findConflicts([M("20260929120000_mine.sql")], main), 1, sha).state, "failure");
  if (fail) {
    console.error(`${fail} self-test case(s) failed`);
    process.exit(1);
  }
  console.log("self-test passed");
}

const CONTEXT = "migration-version-unique";

async function gh(method, path, body) {
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "");
  return { data: await res.json(), next: next ? next[1] : null };
}

async function ghAll(path) {
  const out = [];
  for (let url = path; url; ) {
    const { data, next } = await gh("GET", url);
    out.push(...data);
    url = next;
  }
  return out;
}

function runUrl() {
  const { GITHUB_SERVER_URL: s, GITHUB_REPOSITORY: r, GITHUB_RUN_ID: id } = process.env;
  return s && r && id ? `${s}/${r}/actions/runs/${id}` : undefined;
}

export function mainTag(mainSha) {
  return `main@${mainSha.slice(0, 9)}`;
}

export function statusFor(conflicts, addedMigrations, mainSha) {
  const at = mainTag(mainSha);
  if (conflicts.length)
    return { state: "failure", description: `version ${conflicts[0].version} is already on ${at}; rename the new migration` };
  if (!addedMigrations) return { state: "success", description: `no new migrations (${at})` };
  return { state: "success", description: `no new migration reuses a version on ${at}` };
}

async function postStatus(sha, conflicts, mainSha, dryRun, addedMigrations = 1) {
  const { state, description } = statusFor(conflicts, addedMigrations, mainSha);
  if (dryRun) return console.log(`  [dry-run] status ${state} on ${sha} (${description})`);
  await gh("POST", `/repos/${process.env.GITHUB_REPOSITORY}/statuses/${sha}`, {
    state,
    context: CONTEXT,
    description: description.slice(0, 140),
    target_url: runUrl(),
  });
}

async function recheckOpenPrs(mainRef, dryRun, fetchMain) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  if (fetchMain) fetchMainInto(mainRef);
  let mainSha = revParse(mainRef);
  let onMain = mainFiles(mainSha);
  const prs = await ghAll(`/repos/${repo}/pulls?state=open&base=main&per_page=100`);
  let posted = 0;
  let skipped = 0;
  let bad = 0;
  for (const pr of prs) {
    const statuses = (await gh("GET", `/repos/${repo}/commits/${pr.head.sha}/statuses?per_page=100`)).data;
    const latest = statuses.find((s) => s.context === CONTEXT);
    if (latest?.description?.includes(mainTag(mainSha))) {
      skipped++;
      console.log(`#${pr.number}: already ${latest.state} for ${mainTag(mainSha)}, skipped`);
      continue;
    }
    const files = await ghAll(`/repos/${repo}/pulls/${pr.number}/files?per_page=100`);
    const added = files.filter((f) => ["added", "renamed", "copied"].includes(f.status)).map((f) => f.filename);
    const addedMigrations = added.filter(isMigration).length;
    let conflicts = findConflicts(added, onMain);
    for (let i = 0; i < 3 && fetchMain && !conflicts.length; i++) {
      fetchMainInto(mainRef);
      const now = revParse(mainRef);
      if (now === mainSha) break;
      console.log(`main moved to ${now.slice(0, 9)}; comparing #${pr.number} again`);
      mainSha = now;
      onMain = mainFiles(mainSha);
      conflicts = findConflicts(added, onMain);
    }
    posted++;
    console.log(`#${pr.number}: ${conflicts.length ? "CONFLICT" : addedMigrations ? "ok" : "no new migrations"}`);
    await postStatus(pr.head.sha, conflicts, mainSha, dryRun, addedMigrations);
    if (!conflicts.length) continue;
    bad++;
    console.log(formatConflicts(conflicts));
    const marker = (c) => `<!-- ${CONTEXT}:${c.added}:${c.existing} -->`;
    const comments = await ghAll(`/repos/${repo}/issues/${pr.number}/comments?per_page=100`);
    const fresh = conflicts.filter((c) => !comments.some((cm) => cm.body?.includes(marker(c))));
    if (!fresh.length) continue;
    const body =
      `${fresh.map(marker).join("\n")}\nmain moved after this PR's checks ran.\n\n${formatConflicts(fresh)}\n\n` +
      `The \`${CONTEXT}\` status on this PR stays failing until the new file is renamed and pushed.`;
    if (dryRun) console.log(`  [dry-run] would comment on #${pr.number}`);
    else await gh("POST", `/repos/${repo}/issues/${pr.number}/comments`, { body });
  }
  console.log(`${prs.length} open PR(s) into main: ${posted} got a status (${bad} conflicting), ${skipped} already current`);
}

async function cli() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) return selfTest();
  const opt = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const mainRef = opt("--main-ref");
  const range = opt("--range");
  const statusSha = opt("--status-sha");
  const fetchMain = argv.includes("--fetch-main");
  const recheck = argv.includes("--recheck-open-prs");
  const dryRun = argv.includes("--dry-run");
  if (!mainRef || (!range && !recheck)) {
    console.error(
      "usage: --main-ref origin/main --range <a..b> [--fetch-main] [--status-sha <sha>]\n" +
        "       --main-ref origin/main --recheck-open-prs [--fetch-main] [--dry-run]\n" +
        "       --self-test",
    );
    process.exit(2);
  }
  try {
    if (recheck) return await recheckOpenPrs(mainRef, dryRun, fetchMain);
    const added = lines(git(["diff", "--no-renames", "--diff-filter=A", "--name-only", range, "--", DIR]));
    let mainSha;
    let conflicts;
    for (let i = 0; i < 3; i++) {
      if (fetchMain && i === 0) fetchMainInto(mainRef);
      mainSha = revParse(mainRef);
      conflicts = findConflicts(added, mainFiles(mainSha));
      if (conflicts.length || !fetchMain) break;
      fetchMainInto(mainRef);
      if (revParse(mainRef) === mainSha) break;
      console.log(`main moved during the check (was ${mainSha.slice(0, 9)}); comparing again`);
      if (i === 2) {
        mainSha = revParse(mainRef);
        conflicts = findConflicts(added, mainFiles(mainSha));
      }
    }
    if (statusSha) await postStatus(statusSha, conflicts, mainSha, dryRun);
    if (conflicts.length) {
      console.log(formatConflicts(conflicts));
      process.exit(1);
    }
    console.log(`OK: ${added.filter(isMigration).length} new migration(s), no version already on ${mainRef} (${mainSha.slice(0, 9)}).`);
  } catch (e) {
    console.error(`migration-version-unique: ${e.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await cli();
